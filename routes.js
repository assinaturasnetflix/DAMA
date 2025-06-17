// routes.js

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { User, Item, RechargeRequest, WithdrawalRequest } = require('./models.js');

const router = express.Router();

// --- Middlewares de Autenticação ---
const auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization').replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password');
        if (!req.user || req.user.isBlocked) throw new Error();
        next();
    } catch (error) {
        res.status(401).send({ error: 'Autenticação necessária.' });
    }
};

const adminAuth = (req, res, next) => {
    if (req.user?.role === 'admin') {
        return next();
    }
    return res.status(403).json({ message: 'Acesso negado. Requer privilégios de administrador.' });
};

// --- Configuração de Upload ---
const storage = multer.memoryStorage();
const upload = multer({ storage });


// ===================================
// --- ROTAS DE AUTENTICAÇÃO E USUÁRIO ---
// ===================================

router.post('/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'Por favor, preencha todos os campos.' });
    }
    try {
        if (await User.findOne({ $or: [{ email }, { username }] })) {
            return res.status(400).json({ message: 'Usuário ou email já existe.' });
        }
        const user = new User({ username, email, password });
        await user.save();
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ token, user: { id: user._id, username: user.username } });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor', error: error.message });
    }
});

router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password)) || user.isBlocked) {
            return res.status(400).json({ message: 'Credenciais inválidas ou conta bloqueada.' });
        }
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user._id, username: user.username } });
    } catch (error) {
        res.status(500).json({ message: 'Erro no servidor', error: error.message });
    }
});

router.post('/auth/forgot-password', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });
        if (!user) {
            return res.status(200).json({ message: 'Se um usuário com este email existir, um link de redefinição de senha foi enviado.' });
        }

        const resetToken = crypto.randomBytes(20).toString('hex');

        user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutos
        await user.save();

        const resetURL = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

        const message = `Você está recebendo este email porque solicitou a redefinição da senha da sua conta.\n\n` +
                        `Por favor, clique no seguinte link para completar o processo:\n\n` +
                        `${resetURL}\n\n` +
                        `Se você não solicitou isso, ignore este email.\n`;

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        await transporter.sendMail({
            from: `"Plataforma de Damas" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject: 'Redefinição de Senha',
            text: message
        });

        res.status(200).json({ message: 'Se um usuário com este email existir, um link de redefinição de senha foi enviado.' });

    } catch (error) {
        res.status(500).json({ message: 'Erro ao enviar o email. Tente novamente mais tarde.' });
    }
});

router.post('/auth/reset-password/:token', async (req, res) => {
    const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
    try {
        const user = await User.findOne({
            passwordResetToken: hashedToken,
            passwordResetExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Token inválido ou expirado.' });
        }

        user.password = req.body.password;
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save();

        const loginToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(200).json({ token: loginToken, message: 'Senha redefinida com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao redefinir a senha.' });
    }
});

// ===============================
// --- ROTAS DE PERFIL E RANKING ---
// ===============================

router.get('/profile/me', auth, async (req, res) => {
    try {
        // --- CORREÇÃO APLICADA AQUI ---
        const userProfile = await User.findById(req.user.id)
            .populate([
                { path: 'inventory' },
                { path: 'equippedItems.piece_skin' },
                { path: 'equippedItems.board_skin' }
            ])
            .select('-password -__v');
            
        if (!userProfile) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        res.json(userProfile);
    } catch (error) {
        console.error("Erro na rota /profile/me: ", error); // Log do erro no servidor
        res.status(500).json({ message: 'Erro interno ao buscar dados do perfil.' });
    }
});

router.put('/profile/username', auth, async (req, res) => {
    const { newUsername } = req.body;
    const cost = 100;
    try {
        if (req.user.balance < cost) return res.status(400).json({ message: 'Saldo insuficiente para alterar o nome.' });
        if (await User.findOne({ username: newUsername })) return res.status(400).json({ message: 'Este nome de usuário já está em uso.' });
        
        req.user.username = newUsername;
        req.user.balance -= cost;
        await req.user.save();
        res.json({ message: 'Nome de usuário alterado com sucesso!', newBalance: req.user.balance });
    } catch (error) { res.status(500).json({ message: 'Erro no servidor' }); }
});

router.post('/profile/avatar', auth, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo de imagem enviado.' });
    try {
        if (req.user.avatar && req.user.avatar.public_id) {
            await cloudinary.uploader.destroy(req.user.avatar.public_id);
        }
        const stream = cloudinary.uploader.upload_stream({ folder: "avatars" }, async (error, result) => {
            if (error) return res.status(500).json({ message: 'Falha no upload para o Cloudinary' });
            req.user.avatar = { public_id: result.public_id, url: result.secure_url };
            await req.user.save();
            res.json({ message: 'Avatar atualizado com sucesso!', avatarUrl: result.secure_url });
        });
        Readable.from(req.file.buffer).pipe(stream);
    } catch (error) { res.status(500).json({ message: 'Erro no servidor' }); }
});

router.get('/ranking', auth, async(req, res) => {
    try {
        const leaderboard = await User.find({ role: 'user' })
            .sort({ rankingPoints: -1 })
            .limit(100)
            .select('username rankingPoints level stats.wins avatar.url');
        res.json(leaderboard);
    } catch (error) { res.status(500).json({ message: 'Erro ao buscar o ranking.'}); }
});

// =======================================
// --- ROTAS DA LOJA, PAGAMENTOS E SAQUES ---
// =======================================

router.get('/shop/items', auth, async (req, res) => {
    try { res.json(await Item.find()); } catch (error) { res.status(500).json({ message: 'Erro no servidor' }); }
});

router.post('/shop/buy/:itemId', auth, async (req, res) => {
    try {
        const item = await Item.findById(req.params.itemId);
        if (!item) return res.status(404).json({ message: 'Item não encontrado.' });
        if (req.user.inventory.includes(item._id)) return res.status(400).json({ message: 'Você já possui este item.' });
        if (req.user.balance < item.price) return res.status(400).json({ message: 'Saldo insuficiente.' });
        req.user.balance -= item.price;
        req.user.inventory.push(item._id);
        await req.user.save();
        res.json({ message: `Item '${item.name}' comprado com sucesso!`, newBalance: req.user.balance });
    } catch (error) { res.status(500).json({ message: 'Erro no servidor' }); }
});

router.post('/inventory/equip', auth, async (req, res) => {
    const { itemId } = req.body;
    try {
        const item = await Item.findById(itemId);
        if (!item || !req.user.inventory.includes(itemId)) return res.status(404).json({ message: 'Item inválido.' });
        if (item.type === 'piece_skin') req.user.equippedItems.piece_skin = item._id;
        else if (item.type === 'board_skin') req.user.equippedItems.board_skin = item._id;
        await req.user.save();
        res.json({ message: `'${item.name}' equipado com sucesso!`, equippedItems: req.user.equippedItems });
    } catch (error) { res.status(500).json({ message: 'Erro no servidor' }); }
});

router.post('/payments/recharge-request', auth, async (req, res) => {
    const { amount, paymentMethod, transactionId } = req.body;
    try {
        const request = new RechargeRequest({ user: req.user._id, amount, paymentMethod, transactionId });
        await request.save();
        res.status(201).json({ message: 'Pedido de recarga enviado. Aguardando aprovação.' });
    } catch (error) { res.status(500).json({ message: "Erro ao processar pedido." }); }
});

router.post('/payments/withdraw-request', auth, async (req, res) => {
    const { amount, paymentMethod, userPaymentDetails } = req.body;
    if (!amount || !paymentMethod || !userPaymentDetails) return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    if (req.user.balance < amount) return res.status(400).json({ message: 'Saldo insuficiente.' });
    try {
        req.user.balance -= amount;
        const withdrawal = new WithdrawalRequest({ user: req.user._id, amount, paymentMethod, userPaymentDetails });
        await Promise.all([withdrawal.save(), req.user.save()]);
        res.status(201).json({ message: 'Pedido de saque enviado com sucesso.', newBalance: req.user.balance });
    } catch (error) { res.status(500).json({ message: "Erro ao processar pedido." }); }
});

// ===============================
// --- ROTAS DO PAINEL DE ADMIN ---
// ===============================

router.get('/admin/recharge-requests', auth, adminAuth, async (req, res) => {
    try { res.json(await RechargeRequest.find({ status: 'pending' }).populate('user', 'username email')); }
    catch (e) { res.status(500).send(); }
});

router.post('/admin/recharge-requests/approve/:id', auth, adminAuth, async (req, res) => {
    try {
        const request = await RechargeRequest.findById(req.params.id);
        if (!request || request.status !== 'pending') return res.status(404).json({ message: 'Pedido inválido ou já processado.' });
        await User.findByIdAndUpdate(request.user, { $inc: { balance: request.amount } });
        request.status = 'approved';
        await request.save();
        res.json({ message: 'Recarga aprovada com sucesso.' });
    } catch (e) { res.status(500).send(); }
});

router.get('/admin/withdraw-requests', auth, adminAuth, async (req, res) => {
    try { res.json(await WithdrawalRequest.find({ status: 'pending' }).populate('user', 'username email')); }
    catch (e) { res.status(500).send(); }
});

router.post('/admin/withdraw-requests/approve/:id', auth, adminAuth, async (req, res) => {
    try {
        const request = await WithdrawalRequest.findByIdAndUpdate(req.params.id, { status: 'approved' });
        if (!request) return res.status(404).json({ message: 'Pedido de saque não encontrado.' });
        res.json({ message: 'Saque aprovado e marcado como concluído no sistema.' });
    } catch (e) { res.status(500).send(); }
});

router.post('/admin/users/block/:id', auth, adminAuth, async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, { isBlocked: true });
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        res.json({ message: `Usuário ${user.username} foi bloqueado.` });
    } catch (e) { res.status(500).send(); }
});

router.post('/admin/users/unblock/:id', auth, adminAuth, async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, { isBlocked: false });
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        res.json({ message: `Usuário ${user.username} foi desbloqueado.` });
    } catch (e) { res.status(500).send(); }
});

// Exporta o router para ser usado no arquivo principal do servidor
module.exports = router;