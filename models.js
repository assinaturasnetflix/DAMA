// models.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Schema para os Usuários da plataforma
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    rankingPoints: { type: Number, default: 1000 },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    avatar: { 
        public_id: String, 
        url: { type: String, default: 'https://res.cloudinary.com/demo/image/upload/w_100,h_100,c_thumb,g_face,r_max/face_left.png' }
    },
    inventory: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
    equippedItems: { 
        piece_skin: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' }, 
        board_skin: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' }
    },
    stats: { 
        wins: { type: Number, default: 0 }, 
        losses: { type: Number, default: 0 }, 
        draws: { type: Number, default: 0 } 
    },
    isBlocked: { type: Boolean, default: false },
    // CAMPOS ADICIONADOS PARA RECUPERAÇÃO DE SENHA
    passwordResetToken: String,
    passwordResetExpires: Date,
}, { timestamps: true });

// Middleware para hashear a senha antes de salvar um novo usuário
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// Schema para os Itens da Loja
const itemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, enum: ['piece_skin', 'board_skin'], required: true },
    price: { type: Number, required: true },
    imageUrl: { public_id: String, url: String }
});

// Schema para os Pedidos de Recarga de Saldo
const rechargeRequestSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['M-Pesa', 'e-Mola'], required: true },
    transactionId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

// Schema para os Pedidos de Saque de Saldo
const WithdrawalRequestSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['M-Pesa', 'e-Mola'], required: true },
    userPaymentDetails: { type: String, required: true }, // Ex: número de telefone
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

// Criando os Modelos a partir dos Schemas
const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const RechargeRequest = mongoose.model('RechargeRequest', rechargeRequestSchema);
const WithdrawalRequest = mongoose.model('WithdrawalRequest', WithdrawalRequestSchema);

// Exportando todos os modelos para serem usados em outros arquivos
module.exports = {
    User,
    Item,
    RechargeRequest,
    WithdrawalRequest
};