const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { User, GameMatch, Transaction } = require('./models');

class GameSocket {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL,
        credentials: true
      }
    });

    this.matchmakingQueues = new Map(); // Map of bet amounts to arrays of waiting players
    this.activeGames = new Map(); // Map of room IDs to game states
    this.playerSockets = new Map(); // Map of user IDs to socket IDs
    this.setupSocketHandlers();
  }

  setupSocketHandlers() {
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          return next(new Error('Authentication error'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        
        if (!user || user.isBlocked) {
          return next(new Error('User not found or blocked'));
        }

        socket.user = user;
        next();
      } catch (error) {
        next(new Error('Authentication error'));
      }
    });

    this.io.on('connection', (socket) => {
      console.log(`User connected: ${socket.user.username}`);
      this.playerSockets.set(socket.user.id.toString(), socket.id);

      socket.on('findMatch', (data) => this.handleFindMatch(socket, data));
      socket.on('cancelFindMatch', () => this.handleCancelFindMatch(socket));
      socket.on('createPrivateRoom', (data) => this.handleCreatePrivateRoom(socket, data));
      socket.on('joinPrivateRoom', (data) => this.handleJoinPrivateRoom(socket, data));
      socket.on('makeMove', (data) => this.handleGameMove(socket, data));
      socket.on('surrender', () => this.handleSurrender(socket));
      socket.on('disconnect', () => this.handleDisconnect(socket));

      // Additional event handlers
      socket.on('requestGameState', () => this.handleGameStateRequest(socket));
      socket.on('requestAvailableMoves', (position) => this.handleAvailableMovesRequest(socket, position));
    });
  }

  async handleFindMatch(socket, { betAmount }) {
    try {
      const user = socket.user;
      
      if (betAmount < 0 || user.balance < betAmount) {
        return socket.emit('error', { message: 'Insufficient balance' });
      }

      if (this.isPlayerInQueue(user.id) || this.isPlayerInGame(user.id)) {
        return socket.emit('error', { message: 'Already in queue or game' });
      }

      const queueKey = betAmount.toString();
      if (!this.matchmakingQueues.has(queueKey)) {
        this.matchmakingQueues.set(queueKey, []);
      }

      const queue = this.matchmakingQueues.get(queueKey);
      
      if (queue.length > 0) {
        const opponent = queue.shift();
        await this.createMatch(user, opponent, betAmount);
      } else {
        queue.push({
          id: user.id,
          username: user.username,
          socketId: socket.id
        });
        socket.emit('waitingForMatch');
      }
    } catch (error) {
      socket.emit('error', { message: 'Error finding match' });
    }
  }

  handleCancelFindMatch(socket) {
    const userId = socket.user.id;
    this.removePlayerFromQueue(userId);
    socket.emit('matchCancelled');
  }

  async handleCreatePrivateRoom(socket, { betAmount = 0 }) {
    try {
      const user = socket.user;
      
      if (betAmount > 0 && user.balance < betAmount) {
        return socket.emit('error', { message: 'Insufficient balance' });
      }

      const roomCode = this.generateRoomCode();
      const gameState = this.createGameState({
        roomCode,
        isPrivate: true,
        betAmount,
        creator: user
      });

      this.activeGames.set(roomCode, gameState);
      socket.join(roomCode);
      
      socket.emit('privateRoomCreated', {
        roomCode,
        betAmount
      });
    } catch (error) {
      socket.emit('error', { message: 'Error creating private room' });
    }
  }

  async handleJoinPrivateRoom(socket, { roomCode }) {
    try {
      const user = socket.user;
      const gameState = this.activeGames.get(roomCode);

      if (!gameState) {
        return socket.emit('error', { message: 'Room not found' });
      }

      if (gameState.players.length >= 2) {
        return socket.emit('error', { message: 'Room is full' });
      }

      if (gameState.betAmount > user.balance) {
        return socket.emit('error', { message: 'Insufficient balance' });
      }

      await this.addPlayerToGame(gameState, user);
      socket.join(roomCode);
      
      this.startGame(gameState);
    } catch (error) {
      socket.emit('error', { message: 'Error joining private room' });
    }
  }

  async handleSurrender(socket) {
    try {
      const user = socket.user;
      const gameState = this.findGameByPlayerId(user.id);

      if (!gameState) {
        return socket.emit('error', { message: 'No active game' });
      }

      const winner = gameState.players.find(p => p.id !== user.id);
      await this.handleGameOver(gameState, winner.id);
    } catch (error) {
      socket.emit('error', { message: 'Error processing surrender' });
    }
  }

  handleDisconnect(socket) {
    const userId = socket.user.id;
    this.removePlayerFromQueue(userId);
    
    const gameState = this.findGameByPlayerId(userId);
    if (gameState) {
      this.handlePlayerDisconnect(gameState, userId);
    }

    this.playerSockets.delete(userId);
  }

  createGameState({ roomCode, matchId = null, isPrivate = false, betAmount = 0, creator = null, players = [] }) {
    return {
      roomCode,
      matchId,
      isPrivate,
      betAmount,
      creator: creator?.id,
      players: players.map(p => ({
        id: p.id,
        username: p.username
      })),
      board: this.createInitialBoard(),
      currentTurn: null,
      moveHistory: [],
      lastMove: null,
      gameStats: this.calculateGameStats(this.createInitialBoard())
    };
  }

  createInitialBoard() {
    const board = Array(8).fill(null).map(() => Array(8).fill(null));
    
    // Place black pieces (b)
    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = 'b';
        }
      }
    }
    
    // Place red pieces (r)
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 8; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = 'r';
        }
      }
    }
    
    return board;
  }

  calculateGameStats(board) {
    const stats = {
      black_pieces_count: 0,
      black_kings_count: 0,
      red_pieces_count: 0,
      red_kings_count: 0
    };

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = board[row][col];
        if (piece === 'b') stats.black_pieces_count++;
        else if (piece === 'B') stats.black_kings_count++;
        else if (piece === 'r') stats.red_pieces_count++;
        else if (piece === 'R') stats.red_kings_count++;
      }
    }

    return stats;
  }

  async handleGameMove(socket, { from, to }) {
    try {
      const user = socket.user;
      const gameState = this.findGameByPlayerId(user.id);

      if (!gameState) {
        return socket.emit('error', { message: 'No active game' });
      }

      const playerIndex = gameState.players.findIndex(p => p.id === user.id);
      const playerColor = playerIndex === 0 ? 'b' : 'r';

      if (gameState.currentTurn !== user.id) {
        return socket.emit('error', { message: 'Not your turn' });
      }

      if (gameState.lastMove && gameState.lastMove.playerId === user.id) {
        if (from.row !== gameState.lastMove.endRow || from.col !== gameState.lastMove.endCol) {
          return socket.emit('error', { message: 'Must continue capture sequence with the same piece' });
        }
      }

      const availableCaptures = this.findAllCaptures(gameState.board, playerColor);
      if (availableCaptures.length > 0) {
        const isCapture = this.isCaptureMove(gameState.board, from, to);
        if (!isCapture) {
          return socket.emit('error', { message: 'Capture move is mandatory' });
        }
      }

      if (!this.isValidMove(gameState, from, to, playerColor)) {
        return socket.emit('error', { message: 'Invalid move' });
      }

      const moveResult = this.applyMove(gameState, from, to, playerColor);
      gameState.gameStats = this.calculateGameStats(gameState.board);

      await GameMatch.findByIdAndUpdate(gameState.matchId, {
        $push: {
          moves: {
            from,
            to,
            player: user.id
          }
        }
      });

      this.io.to(gameState.roomCode).emit('moveApplied', {
        from,
        to,
        player: user.id,
        gameStats: gameState.gameStats,
        capturedPiece: moveResult.capturedPiece
      });

      const moreCapturesAvailable = moveResult.isCapture && 
        this.findCapturesForPiece(gameState.board, to.row, to.col).length > 0;

      if (moreCapturesAvailable) {
        gameState.lastMove = {
          playerId: user.id,
          endRow: to.row,
          endCol: to.col
        };
        socket.emit('continuedTurn', { message: 'Additional captures available' });
      } else {
        gameState.lastMove = null;
        gameState.currentTurn = gameState.players.find(p => p.id !== user.id).id;
        this.io.to(gameState.roomCode).emit('turnChanged', {
          currentTurn: gameState.currentTurn
        });
      }

      if (this.isGameOver(gameState)) {
        await this.handleGameOver(gameState);
      }
    } catch (error) {
      socket.emit('error', { message: 'Error processing move' });
    }
  }

  isValidMove(gameState, from, to, playerColor) {
    const { board } = gameState;
    const piece = board[from.row][from.col];

    if (!piece || piece.toLowerCase() !== playerColor) return false;
    if (board[to.row][to.col] !== null) return false;

    const isKing = piece === piece.toUpperCase();
    const moveDistance = {
      row: Math.abs(to.row - from.row),
      col: Math.abs(to.col - from.col)
    };

    if (moveDistance.row !== moveDistance.col) return false;

    if (moveDistance.row === 1) {
      if (!isKing) {
        const forward = playerColor === 'b' ? -1 : 1;
        return (to.row - from.row) === forward;
      }
      return true;
    }

    return this.isValidCapture(board, from, to, playerColor, isKing);
  }

  isValidCapture(board, from, to, playerColor, isKing) {
    const captureRow = Math.floor((from.row + to.row) / 2);
    const captureCol = Math.floor((from.col + to.col) / 2);
    const capturedPiece = board[captureRow][captureCol];

    if (!capturedPiece || capturedPiece.toLowerCase() === playerColor) return false;

    if (isKing) {
      const rowStep = Math.sign(to.row - from.row);
      const colStep = Math.sign(to.col - from.col);
      let row = from.row + rowStep;
      let col = from.col + colStep;
      let foundCapture = false;

      while (row !== to.row && col !== to.col) {
        if (board[row][col] !== null) {
          if (foundCapture) return false;
          if (board[row][col].toLowerCase() === playerColor) return false;
          foundCapture = true;
        }
        row += rowStep;
        col += colStep;
      }

      return foundCapture;
    }

    return Math.abs(to.row - from.row) === 2;
  }

  findAllCaptures(board, playerColor) {
    const captures = [];
    
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = board[row][col];
        if (piece && piece.toLowerCase() === playerColor) {
          const pieceCaptures = this.findCapturesForPiece(board, row, col);
          captures.push(...pieceCaptures);
        }
      }
    }
    
    return captures;
  }

  findCapturesForPiece(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];

    const playerColor = piece.toLowerCase();
    const isKing = piece === piece.toUpperCase();
    const captures = [];

    if (isKing) {
      const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (const [rowDir, colDir] of directions) {
        let r = row + rowDir;
        let c = col + colDir;
        let foundOpponent = false;
        let opponentPos = null;

        while (r >= 0 && r < 8 && c >= 0 && c < 8) {
          if (board[r][c] !== null) {
            if (!foundOpponent && board[r][c].toLowerCase() !== playerColor) {
              foundOpponent = true;
              opponentPos = { row: r, col: c };
            } else {
              break;
            }
          } else if (foundOpponent) {
            captures.push({
              from: { row, col },
              to: { row: r, col: c },
              captured: opponentPos
            });
          }
          r += rowDir;
          c += colDir;
        }
      }
    } else {
      const directions = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
      for (const [rowDiff, colDiff] of directions) {
        const newRow = row + rowDiff;
        const newCol = col + colDiff;
        
        if (newRow >= 0 && newRow < 8 && newCol >= 0 && newCol < 8 && board[newRow][newCol] === null) {
          const jumpRow = row + rowDiff/2;
          const jumpCol = col + colDiff/2;
          const jumpedPiece = board[jumpRow][jumpCol];
          
          if (jumpedPiece && jumpedPiece.toLowerCase() !== playerColor) {
            captures.push({
              from: { row, col },
              to: { row: newRow, col: newCol },
              captured: { row: jumpRow, col: jumpCol }
            });
          }
        }
      }
    }

    return captures;
  }

  applyMove(gameState, from, to, playerColor) {
    const { board } = gameState;
    const piece = board[from.row][from.col];
    const moveResult = {
      isCapture: false,
      capturedPiece: null
    };

    board[to.row][to.col] = piece;
    board[from.row][from.col] = null;

    if (Math.abs(to.row - from.row) >= 2) {
      const captureRow = Math.floor((from.row + to.row) / 2);
      const captureCol = Math.floor((from.col + to.col) / 2);
      moveResult.capturedPiece = board[captureRow][captureCol];
      board[captureRow][captureCol] = null;
      moveResult.isCapture = true;
    }

    const lastRow = playerColor === 'b' ? 0 : 7;
    if (to.row === lastRow && piece === playerColor) {
      board[to.row][to.col] = piece.toUpperCase();
    }

    return moveResult;
  }

  isGameOver(gameState) {
    const nextPlayer = gameState.currentTurn;
    const playerColor = gameState.players[0].id === nextPlayer ? 'b' : 'r';

    const hasPieces = gameState.board.some(row => 
      row.some(cell => cell && cell.toLowerCase() === playerColor)
    );

    if (!hasPieces) return true;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = gameState.board[row][col];
        if (piece && piece.toLowerCase() === playerColor) {
          if (this.findCapturesForPiece(gameState.board, row, col).length > 0) {
            return false;
          }

          const isKing = piece === piece.toUpperCase();
          const directions = isKing ? [-1, 1] : [playerColor === 'b' ? -1 : 1];
          
          for (const rowDir of directions) {
            for (const colDir of [-1, 1]) {
              const newRow = row + rowDir;
              const newCol = col + colDir;
              
              if (newRow >= 0 && newRow < 8 && newCol >= 0 && newCol < 8 && 
                  gameState.board[newRow][newCol] === null) {
                return false;
              }
            }
          }
        }
      }
    }

    return true;
  }

  // Helper methods
  async createMatch(player1, player2, betAmount) {
    try {
      const match = new GameMatch({
        players: [
          { user: player1.id },
          { user: player2.id }
        ],
        betAmount,
        status: 'active',
        startTime: new Date()
      });
      await match.save();

      await Promise.all([
        this.deductBet(player1.id, betAmount),
        this.deductBet(player2.id, betAmount)
      ]);

      const gameState = this.createGameState({
        matchId: match._id,
        roomCode: match._id.toString(),
        betAmount,
        players: [player1, player2]
      });

      this.activeGames.set(gameState.roomCode, gameState);

      const player1Socket = this.io.sockets.sockets.get(this.playerSockets.get(player1.id));
      const player2Socket = this.io.sockets.sockets.get(this.playerSockets.get(player2.id));

      player1Socket?.join(gameState.roomCode);
      player2Socket?.join(gameState.roomCode);

      this.startGame(gameState);
    } catch (error) {
      console.error('Error creating match:', error);
      throw error;
    }
  }

  async deductBet(userId, amount) {
    const user = await User.findById(userId);
    user.balance -= amount;
    await user.save();

    await Transaction.create({
      user: userId,
      type: 'bet',
      amount: -amount,
      description: 'Game bet placed',
      balanceAfter: user.balance
    });
  }

  async handleGameOver(gameState, forcedWinnerId = null) {
    try {
      const match = await GameMatch.findById(gameState.matchId);
      const winner = forcedWinnerId || this.determineWinner(gameState);
      const totalPrize = gameState.betAmount * 2;

      match.status = 'completed';
      match.winner = winner;
      match.endTime = new Date();
      await match.save();

      const winnerUser = await User.findById(winner);
      winnerUser.stats.wins += 1;
      winnerUser.balance += totalPrize;
      winnerUser.totalWinnings += totalPrize;
      await winnerUser.save();

      const loser = gameState.players.find(p => p.id !== winner);
      const loserUser = await User.findById(loser.id);
      loserUser.stats.losses += 1;
      await loserUser.save();

      await Transaction.create({
        user: winner,
        type: 'win',
        amount: totalPrize,
        description: 'Game won',
        relatedMatch: match._id,
        balanceAfter: winnerUser.balance
      });

      this.io.to(gameState.roomCode).emit('gameOver', {
        winner,
        prize: totalPrize
      });

      this.activeGames.delete(gameState.roomCode);
    } catch (error) {
      console.error('Error handling game over:', error);
      throw error;
    }
  }

  generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  isPlayerInQueue(userId) {
    for (const queue of this.matchmakingQueues.values()) {
      if (queue.some(p => p.id === userId)) return true;
    }
    return false;
  }

  isPlayerInGame(userId) {
    for (const game of this.activeGames.values()) {
      if (game.players.some(p => p.id === userId)) return true;
    }
    return false;
  }

  removePlayerFromQueue(userId) {
    for (const queue of this.matchmakingQueues.values()) {
      const index = queue.findIndex(p => p.id === userId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  }

  findGameByPlayerId(userId) {
    for (const game of this.activeGames.values()) {
      if (game.players.some(p => p.id === userId)) return game;
    }
    return null;
  }

  handlePlayerDisconnect(gameState, userId) {
    if (gameState.players.length < 2) {
      this.activeGames.delete(gameState.roomCode);
    } else {
      const winner = gameState.players.find(p => p.id !== userId);
      this.handleGameOver(gameState, winner.id);
    }
  }

  // Additional helper methods for new features
  handleGameStateRequest(socket) {
    const gameState = this.findGameByPlayerId(socket.user.id);
    if (gameState) {
      socket.emit('gameState', {
        board: gameState.board,
        currentTurn: gameState.currentTurn,
        gameStats: gameState.gameStats
      });
    }
  }

  handleAvailableMovesRequest(socket, position) {
    const gameState = this.findGameByPlayerId(socket.user.id);
    if (!gameState || gameState.currentTurn !== socket.user.id) {
      return socket.emit('error', { message: 'Not your turn' });
    }

    const playerColor = gameState.players[0].id === socket.user.id ? 'b' : 'r';
    const piece = gameState.board[position.row][position.col];

    if (!piece || piece.toLowerCase() !== playerColor) {
      return socket.emit('availableMoves', []);
    }

    const captures = this.findCapturesForPiece(gameState.board, position.row, position.col);
    if (captures.length > 0) {
      return socket.emit('availableMoves', captures);
    }

    const regularMoves = this.findRegularMoves(gameState.board, position.row, position.col);
    socket.emit('availableMoves', regularMoves);
  }

  findRegularMoves(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];

    const moves = [];
    const playerColor = piece.toLowerCase();
    const isKing = piece === piece.toUpperCase();

    if (isKing) {
      // King can move in all diagonal directions
      const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (const [rowDir, colDir] of directions) {
        let r = row + rowDir;
        let c = col + colDir;
        
        while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === null) {
          moves.push({
            from: { row, col },
            to: { row: r, col: c }
          });
          r += rowDir;
          c += colDir;
        }
      }
    } else {
      // Regular piece moves
      const forward = playerColor === 'b' ? -1 : 1;
      const possibleMoves = [
        [forward, -1],
        [forward, 1]
      ];

      for (const [rowDiff, colDiff] of possibleMoves) {
        const newRow = row + rowDiff;
        const newCol = col + colDiff;
        
        if (newRow >= 0 && newRow < 8 && newCol >= 0 && newCol < 8 && 
            board[newRow][newCol] === null) {
          moves.push({
            from: { row, col },
            to: { row: newRow, col: newCol }
          });
        }
      }
    }

    return moves;
  }
}

module.exports = GameSocket;