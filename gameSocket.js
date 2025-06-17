// gameSocket.js

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User } = require('./models.js'); // Importa apenas o modelo de usuário

// --- Variáveis de estado do jogo (em memória) ---
const openWagers = new Map(); // Armazena apostas abertas: Map<userId, wagerDetails>
const activeGames = {}; // Armazena jogos ativos: { roomId: gameData }
const onlineUsers = new Map(); // Armazena usuários online: Map<userId, socketId>

// --- Constantes de Jogo e Recompensas ---
const PR_CHANGE = 15; // Pontos de Ranking ganhos/perdidos por partida
const WINNER_XP = 50; // XP para o vencedor
const LOSER_XP = 25;  // XP para o perdedor
const XP_PER_LEVEL = 200; // XP necessário para subir de nível
const LEVEL_REWARDS = { // Recompensas por nível: Nível -> ID do Item no banco de dados
    5: '666dd934d47b0a03c3f87f85', // Exemplo de ID de item
    10: '666dd94ed47b0a03c3f87f88', // Exemplo de ID de item
};

// --- Função principal que inicializa toda a lógica do Socket.IO ---
function initializeSocket(io) {

    // Middleware de autenticação para cada nova conexão de socket
    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth.token;
            if (!token) throw new Error('Token não fornecido');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            socket.userId = decoded.id;
            next();
        } catch (err) {
            next(new Error('Erro de autenticação'));
        }
    });

    // Lida com eventos de cada cliente conectado
    io.on('connection', (socket) => {
        console.log(`[Socket] Usuário conectado: ${socket.userId} com ID de socket: ${socket.id}`);
        onlineUsers.set(socket.userId, socket.id);

        // Envia o estado atual do lobby para o novo usuário
        socket.emit('updateLobby', Array.from(openWagers.values()));

        // --- Lógica do Lobby de Apostas ---
        socket.on('hostWageredGame', async ({ betAmount }) => {
            try {
                const user = await User.findById(socket.userId);
                if (!user || user.balance < betAmount || betAmount <= 0) {
                    return socket.emit('error', { message: 'Saldo insuficiente ou valor de aposta inválido.' });
                }
                if (openWagers.has(socket.userId)) {
                    return socket.emit('error', { message: 'Você já tem uma aposta aberta.' });
                }

                const wagerDetails = {
                    userId: user._id.toString(),
                    username: user.username,
                    rankingPoints: user.rankingPoints,
                    betAmount,
                };
                openWagers.set(socket.userId, wagerDetails);
                // Notifica todos os clientes sobre a nova aposta no lobby
                io.emit('updateLobby', Array.from(openWagers.values()));
            } catch(e) { socket.emit('error', { message: 'Erro ao criar aposta.' }); }
        });
        
        socket.on('cancelWager', () => {
            if (openWagers.has(socket.userId)) {
                openWagers.delete(socket.userId);
                io.emit('updateLobby', Array.from(openWagers.values()));
            }
        });

        socket.on('acceptWager', async ({ hostUserId }) => {
            const hostWager = openWagers.get(hostUserId);
            if (!hostWager) return socket.emit('error', { message: 'Este jogador não está mais esperando por um oponente.' });
            
            const challenger = await User.findById(socket.userId);
            if (!challenger) return socket.emit('error', { message: 'Erro ao encontrar seu usuário.' });
            if (challenger.balance < hostWager.betAmount) {
                return socket.emit('error', { message: 'Você não tem saldo suficiente para aceitar esta aposta.' });
            }
            if (challenger._id.toString() === hostUserId) {
                 return socket.emit('error', { message: 'Você não pode jogar contra si mesmo.' });
            }

            openWagers.delete(hostUserId);
            io.emit('updateLobby', Array.from(openWagers.values()));

            const betAmount = hostWager.betAmount;
            try {
                await Promise.all([
                    User.findByIdAndUpdate(hostUserId, { $inc: { balance: -betAmount } }),
                    User.findByIdAndUpdate(challenger._id, { $inc: { balance: -betAmount } })
                ]);
            } catch (error) {
                return io.to(socket.id).to(hostWager.socketId).emit('error', { message: 'Erro ao processar apostas, a partida foi cancelada.'});
            }

            const hostSocket = io.sockets.sockets.get(onlineUsers.get(hostUserId));
            if (!hostSocket) return socket.emit('error', { message: 'Oponente desconectou.' });
            
            const roomId = `game_${crypto.randomBytes(4).toString('hex')}`;
            hostSocket.join(roomId);
            socket.join(roomId);

            const gameData = {
                roomId,
                board: [
                    [null,'r',null,'r',null,'r',null,'r'],['r',null,'r',null,'r',null,'r',null],[null,'r',null,'r',null,'r',null,'r'],
                    [null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],
                    ['b',null,'b',null,'b',null,'b',null],[null,'b',null,'b',null,'b',null,'b'],['b',null,'b',null,'b',null,'b',null]
                ],
                players: [
                    { userId: hostUserId, username: hostWager.username, color: 'b' },
                    { userId: challenger._id.toString(), username: challenger.username, color: 'r' }
                ],
                turnIndex: 0,
                isFinished: false,
                pot: betAmount * 2
            };
            activeGames[roomId] = gameData;
            io.to(roomId).emit('matchFound', gameData);
        });

        // --- Lógica do Jogo ---
        socket.on('makeMove', (data) => handleMakeMove(io, socket, data));

        // --- Desconexão ---
        socket.on('disconnect', () => handleDisconnect(io, socket.userId));
    });
}


// ===================================
// === MOTOR DE REGRAS DE DAMAS ======
// ===================================

function calculateRawMoves(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];
    
    const moves = [];
    const isKing = piece === 'B' || piece === 'R';
    const opponent = piece.toLowerCase() === 'b' ? 'r' : 'b';
    const moveDirections = (piece === 'b') ? [[-1, -1], [-1, 1]] : (piece === 'r') ? [[1, -1], [1, 1]] : [];
    const captureDirections = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

    // Movimentos simples
    if (isKing) {
        for (const [dr, dc] of captureDirections) {
            for (let i = 1; i < 8; i++) {
                const destRow = row + i * dr, destCol = col + i * dc;
                if (destRow < 0 || destRow >= 8 || destCol < 0 || destCol >= 8 || board[destRow][destCol] !== null) break;
                moves.push({ from: {row, col}, to: { row: destRow, col: destCol }, isJump: false, captured: [] });
            }
        }
    } else {
        for (const [dr, dc] of moveDirections) {
            const destRow = row + dr, destCol = col + dc;
            if (destRow >= 0 && destRow < 8 && destCol >= 0 && destCol < 8 && board[destRow][destCol] === null) {
                moves.push({ from: {row, col}, to: { row: destRow, col: destCol }, isJump: false, captured: [] });
            }
        }
    }

    // Capturas
    for (const [dr, dc] of captureDirections) {
        if (isKing) {
            let capturedPiece = null;
            for (let i = 1; i < 8; i++) {
                const checkRow = row + i * dr, checkCol = col + i * dc;
                if (checkRow < 0 || checkRow >= 8 || checkCol < 0 || checkCol >= 8) break;
                const squareContent = board[checkRow][checkCol];
                if (squareContent) {
                    if (squareContent.toLowerCase() === opponent && !capturedPiece) capturedPiece = { row: checkRow, col: checkCol };
                    else break;
                } else if (capturedPiece) {
                    moves.push({ from: {row, col}, to: { row: checkRow, col: checkCol }, isJump: true, captured: [capturedPiece] });
                }
            }
        } else {
            const middleRow = row + dr, middleCol = col + dc;
            const destRow = row + 2 * dr, destCol = col + 2 * dc;
            if (destRow >= 0 && destRow < 8 && destCol >= 0 && destCol < 8 && board[destRow][destCol] === null && board[middleRow]?.[middleCol]?.toLowerCase() === opponent) {
                moves.push({ from: {row, col}, to: { row: destRow, col: destCol }, isJump: true, captured: [{ row: middleRow, col: middleCol }] });
            }
        }
    }
    return moves;
}

function findAllPossibleMoves(board, playerColor) {
    let allMoves = [];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (board[r][c] && board[r][c].toLowerCase() === playerColor) {
                allMoves.push(...calculateRawMoves(board, r, c));
            }
        }
    }
    const jumpMoves = allMoves.filter(m => m.isJump);
    return jumpMoves.length > 0 ? jumpMoves : allMoves;
}

function updateBoardState(board, move) {
    const { from, to, captured } = move;
    let pieceType = board[from.row][from.col];
    if ((pieceType === 'b' && to.row === 0) || (pieceType === 'r' && to.row === 7)) {
        pieceType = pieceType.toUpperCase();
    }
    board[to.row][to.col] = pieceType;
    board[from.row][from.col] = null;
    captured.forEach(p => { board[p.row][p.col] = null; });
}

function checkWinCondition(board, nextPlayerColor) {
    const opponentColor = nextPlayerColor === 'b' ? 'r' : 'b';
    const opponentPieces = board.flat().filter(p => p?.toLowerCase() === opponentColor).length;
    if (opponentPieces === 0) return nextPlayerColor;
    
    const nextPlayerMoves = findAllPossibleMoves(board, nextPlayerColor);
    if (nextPlayerMoves.length === 0) return opponentColor;
    
    return null;
}


// =======================================
// === GERENCIAMENTO DO CICLO DE JOGO ====
// =======================================

async function handleMakeMove(io, socket, { roomId, move }) {
    try {
        const game = activeGames[roomId];
        if (!game || socket.userId !== game.players[game.turnIndex].userId) return;

        const currentPlayer = game.players[game.turnIndex];
        const legalMoves = findAllPossibleMoves(game.board, currentPlayer.color);
        const attemptedMove = legalMoves.find(m => m.from.row === move.from.row && m.from.col === move.from.col && m.to.row === move.to.row && m.to.col === move.to.col);

        if (!attemptedMove) return socket.emit('error', { message: "Movimento ilegal!" });

        updateBoardState(game.board, attemptedMove);
        const furtherJumps = attemptedMove.isJump ? calculateRawMoves(game.board, move.to.row, move.to.col).filter(m => m.isJump) : [];

        if (furtherJumps.length > 0) {
            io.to(roomId).emit('gameStateUpdate', { board: game.board, turn: currentPlayer.color });
        } else {
            game.turnIndex = 1 - game.turnIndex;
            const nextPlayer = game.players[game.turnIndex];
            io.to(roomId).emit('gameStateUpdate', { board: game.board, turn: nextPlayer.color });
            
            const winnerColor = checkWinCondition(game.board, nextPlayer.color);
            if (winnerColor) await handleGameOver(io, roomId, winnerColor);
        }
    } catch (error) { console.error("Error in handleMakeMove:", error); }
}

async function handleGameOver(io, roomId, winnerColor) {
    const game = activeGames[roomId];
    if (!game || game.isFinished) return;
    game.isFinished = true;

    const winner = game.players.find(p => p.color === winnerColor);
    const loser = game.players.find(p => p.color !== winnerColor);

    if (!winner || !loser) return delete activeGames[roomId];

    try {
        const winnerUpdatePromise = User.findByIdAndUpdate(winner.userId, { 
            $inc: { 'stats.wins': 1, rankingPoints: PR_CHANGE, xp: WINNER_XP, balance: game.pot }
        }, { new: true });

        const loserUpdatePromise = User.findByIdAndUpdate(loser.userId, { 
            $inc: { 'stats.losses': 1, rankingPoints: -PR_CHANGE, xp: LOSER_XP }
        }, { new: true });
        
        const [winnerDoc, loserDoc] = await Promise.all([winnerUpdatePromise, loserUpdatePromise]);

        io.to(roomId).emit('gameOver', { winnerUsername: winnerDoc.username, pot: game.pot });

        if (winnerDoc) await checkLevelUp(io, winnerDoc);
        if (loserDoc) await checkLevelUp(io, loserDoc);

    } catch (error) { console.error("Erro ao finalizar jogo:", error); }
    finally {
        delete activeGames[roomId];
    }
}

async function handleDisconnect(io, userId) {
    console.log(`[Socket] Usuário desconectado: ${userId}`);
    onlineUsers.delete(userId);
    if(openWagers.has(userId)){
        openWagers.delete(userId);
        io.emit('updateLobby', Array.from(openWagers.values()));
    }
    const roomId = Object.keys(activeGames).find(key => activeGames[key]?.players.some(p => p.userId === userId));
    if (roomId && !activeGames[roomId].isFinished) {
        const game = activeGames[roomId];
        const remainingPlayer = game.players.find(p => p.userId !== userId);
        if (remainingPlayer) await handleGameOver(io, roomId, remainingPlayer.color);
    }
}

async function checkLevelUp(io, user) {
    if (user.xp >= XP_PER_LEVEL) {
        const newLevel = user.level + 1;
        const newXp = user.xp % XP_PER_LEVEL;
        const updateData = { level: newLevel, xp: newXp, $addToSet: {} };

        const rewardItemId = LEVEL_REWARDS[newLevel];
        if (rewardItemId) {
            updateData.$addToSet.inventory = rewardItemId;
        } else {
            delete updateData.$addToSet;
        }

        await User.findByIdAndUpdate(user._id, updateData);
        const socketId = onlineUsers.get(user._id.toString());
        if (socketId) {
            io.to(socketId).emit('levelUp', { newLevel, reward: rewardItemId ? "Você ganhou um novo item!" : null });
        }
    }
}

// Exporta a função de inicialização
module.exports = initializeSocket;