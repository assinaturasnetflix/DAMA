const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// User Schema
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  stats: {
    wins: {
      type: Number,
      default: 0
    },
    losses: {
      type: Number,
      default: 0
    }
  },
  totalWinnings: {
    type: Number,
    default: 0
  },
  avatar: {
    public_id: String,
    url: {
      type: String,
      default: 'https://res.cloudinary.com/default/avatar.png'
    }
  },
  isBlocked: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Payment Request Schema
const paymentRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['recharge', 'withdraw'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  proofOfPayment: {
    public_id: String,
    url: String
  },
  notes: String,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  processedAt: Date
}, {
  timestamps: true
});

// Game Match Schema
const gameMatchSchema = new mongoose.Schema({
  players: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    isWinner: {
      type: Boolean,
      default: false
    }
  }],
  betAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled'],
    default: 'active'
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  roomCode: {
    type: String,
    sparse: true
  },
  moves: [{
    from: {
      x: Number,
      y: Number
    },
    to: {
      x: Number,
      y: Number
    },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  startTime: Date,
  endTime: Date
}, {
  timestamps: true
});

// Transaction Schema
const transactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['bet', 'win', 'recharge', 'withdrawal'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  relatedMatch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GameMatch'
  },
  relatedPaymentRequest: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentRequest'
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'completed'
  }
}, {
  timestamps: true
});

// Reset Code Schema (Nova funcionalidade)
const resetCodeSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  code: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 900 // Código expira após 15 minutos
  }
});

// Password hashing middleware
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Create indexes
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });
userSchema.index({ totalWinnings: -1 }); // Para queries de ranking
gameMatchSchema.index({ roomCode: 1 });
paymentRequestSchema.index({ status: 1, type: 1 });
transactionSchema.index({ user: 1, createdAt: -1 }); // Para histórico de transações do usuário
transactionSchema.index({ type: 1, createdAt: -1 }); // Para filtrar transações por tipo
transactionSchema.index({ status: 1 }); // Para filtrar por status

// Create models
const User = mongoose.model('User', userSchema);
const PaymentRequest = mongoose.model('PaymentRequest', paymentRequestSchema);
const GameMatch = mongoose.model('GameMatch', gameMatchSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const ResetCode = mongoose.model('ResetCode', resetCodeSchema);

// Export models
module.exports = {
  User,
  PaymentRequest,
  GameMatch,
  Transaction,
  ResetCode
};