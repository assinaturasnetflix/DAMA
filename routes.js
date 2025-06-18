const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const { isAuthenticated, isAdmin } = require('./middleware');
const { User, PaymentRequest, GameMatch, Transaction, ResetCode } = require('./models');

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

// Authentication Routes
router.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists
    const userExists = await User.findOne({ $or: [{ email }, { username }] });
    if (userExists) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    // Create new user
    const user = new User({ username, email, password });
    await user.save();

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error creating user', error: error.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user and check if blocked
    const user = await User.findOne({ email });
    if (!user || user.isBlocked) {
      return res.status(401).json({ message: 'Invalid credentials or account blocked' });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        balance: user.balance,
        stats: user.stats
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error during login', error: error.message });
  }
});

// Profile Routes
router.get('/profile/me', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching profile', error: error.message });
  }
});

router.post('/profile/avatar', isAuthenticated, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.buffer, {
      folder: 'avatars',
      resource_type: 'auto'
    });

    // Update user's avatar
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        avatar: {
          public_id: result.public_id,
          url: result.secure_url
        }
      },
      { new: true }
    ).select('-password');

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error uploading avatar', error: error.message });
  }
});

// Ranking Routes
router.get('/ranking', async (req, res) => {
  try {
    const topPlayers = await User.find({ role: 'user' })
      .sort({ totalWinnings: -1 })
      .limit(100)
      .select('username stats totalWinnings avatar.url');
    
    res.json(topPlayers);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching ranking', error: error.message });
  }
});

// Transaction Routes
router.get('/transactions', isAuthenticated, async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const query = { user: req.user.id };
    
    if (type) {
      query.type = type;
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('relatedMatch', 'roomCode')
      .populate('relatedPaymentRequest', 'status');

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching transactions', error: error.message });
  }
});

// Payment Routes
router.post('/payments/recharge-request', isAuthenticated, upload.single('proof'), async (req, res) => {
  try {
    const { amount } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'Proof of payment is required' });
    }

    // Upload proof to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.buffer, {
      folder: 'payment_proofs',
      resource_type: 'auto'
    });

    // Create payment request
    const paymentRequest = new PaymentRequest({
      user: req.user.id,
      type: 'recharge',
      amount: parseFloat(amount),
      proofOfPayment: {
        public_id: result.public_id,
        url: result.secure_url
      }
    });
    await paymentRequest.save();

    // Create transaction record
    const transaction = new Transaction({
      user: req.user.id,
      type: 'recharge',
      amount: parseFloat(amount),
      status: 'pending',
      description: 'Recharge request submitted',
      relatedPaymentRequest: paymentRequest._id,
      balanceAfter: req.user.balance
    });
    await transaction.save();

    res.status(201).json(paymentRequest);
  } catch (error) {
    res.status(500).json({ message: 'Error creating recharge request', error: error.message });
  }
});

router.post('/payments/withdraw-request', isAuthenticated, async (req, res) => {
  try {
    const { amount } = req.body;
    const user = await User.findById(req.user.id);

    if (user.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Create withdrawal request
    const paymentRequest = new PaymentRequest({
      user: req.user.id,
      type: 'withdraw',
      amount: parseFloat(amount)
    });
    await paymentRequest.save();

    // Update user balance
    user.balance -= parseFloat(amount);
    await user.save();

    // Create transaction record
    const transaction = new Transaction({
      user: req.user.id,
      type: 'withdrawal',
      amount: -parseFloat(amount),
      status: 'pending',
      description: 'Withdrawal request submitted',
      relatedPaymentRequest: paymentRequest._id,
      balanceAfter: user.balance
    });
    await transaction.save();

    res.status(201).json(paymentRequest);
  } catch (error) {
    res.status(500).json({ message: 'Error creating withdrawal request', error: error.message });
  }
});

// Admin Routes
router.get('/admin/stats', isAdmin, async (req, res) => {
  try {
    const stats = await Promise.all([
      User.countDocuments({ role: 'user' }),
      PaymentRequest.countDocuments({ status: 'pending' }),
      Transaction.aggregate([
        { $match: { type: { $in: ['recharge', 'withdrawal'] }, status: 'completed' } },
        { $group: {
          _id: '$type',
          total: { $sum: '$amount' }
        }}
      ])
    ]);

    res.json({
      totalUsers: stats[0],
      pendingRequests: stats[1],
      financialStats: stats[2]
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching admin stats', error: error.message });
  }
});

router.get('/admin/payment-requests', isAdmin, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (type) query.type = type;

    const requests = await PaymentRequest.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'username email');

    const total = await PaymentRequest.countDocuments(query);

    res.json({
      requests,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching payment requests', error: error.message });
  }
});

router.post('/admin/payment-requests/:id/process', isAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const request = await PaymentRequest.findById(req.params.id)
      .populate('user');

    if (!request) {
      return res.status(404).json({ message: 'Payment request not found' });
    }

    request.status = status;
    request.notes = notes;
    request.processedBy = req.user.id;
    request.processedAt = new Date();
    await request.save();

    const transaction = await Transaction.findOne({ relatedPaymentRequest: request._id });
    transaction.status = status === 'approved' ? 'completed' : 'failed';
    await transaction.save();

    if (status === 'approved' && request.type === 'recharge') {
      request.user.balance += request.amount;
      await request.user.save();
    }

    res.json(request);
  } catch (error) {
    res.status(500).json({ message: 'Error processing payment request', error: error.message });
  }
});

router.get('/admin/users', isAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { role: 'user' };
    
    if (search) {
      query.$or = [
        { username: new RegExp(search, 'i') },
        { email: new RegExp(search, 'i') }
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await User.countDocuments(query);

    res.json({
      users,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching users', error: error.message });
  }
});

router.post('/admin/users/:id/block', isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBlocked: true },
      { new: true }
    ).select('-password');

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error blocking user', error: error.message });
  }
});

router.post('/admin/users/:id/unblock', isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBlocked: false },
      { new: true }
    ).select('-password');

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error unblocking user', error: error.message });
  }
});

// Password Reset Routes (New)
const generateResetCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

router.post('/auth/request-reset-code', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.json({ message: 'Se o email existir, você receberá um código de redefinição.' });
    }

    const resetCode = generateResetCode();

    await ResetCode.create({
      user: user._id,
      code: resetCode
    });

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: 'Código de Redefinição de Senha - Plataforma de Damas Online',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #f97316;">Redefinição de Senha</h2>
          <p>Você solicitou a redefinição de sua senha na Plataforma de Damas Online.</p>
          <p>Use o código abaixo para redefinir sua senha:</p>
          <div style="text-align: center; margin: 30px 0;">
            <div style="background-color: #f0f0f0; 
                        padding: 20px; 
                        font-size: 24px; 
                        letter-spacing: 5px;
                        font-weight: bold;
                        border-radius: 5px;">
              ${resetCode}
            </div>
          </div>
          <p>Este código é válido por 15 minutos.</p>
          <p>Se você não solicitou esta redefinição, ignore este email.</p>
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            Este é um email automático. Por favor, não responda.
          </p>
        </div>
      `
    };

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail(mailOptions);

    res.json({ 
      message: 'Se o email existir, você receberá um código de redefinição.',
      success: true
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ 
      message: 'Erro ao processar solicitação de redefinição de senha',
      success: false
    });
  }
});

router.post('/auth/reset-password', async (req, res) => {
  try {
    const { code, email, newPassword } = req.body;

    if (!code || !email || !newPassword) {
      return res.status(400).json({
        message: 'Código, email e nova senha são obrigatórios',
        success: false
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({
        message: 'Código inválido ou expirado',
        success: false
      });
    }

    const resetCodeDoc = await ResetCode.findOne({
      user: user._id,
      code: code
    });

    if (!resetCodeDoc) {
      return res.status(400).json({
        message: 'Código inválido ou expirado',
        success: false
      });
    }

    user.password = newPassword;
    await user.save();

    await ResetCode.deleteOne({ _id: resetCodeDoc._id });

    res.json({
      message: 'Senha atualizada com sucesso',
      success: true
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({
      message: 'Erro ao redefinir senha',
      success: false
    });
  }
});

router.post('/auth/verify-reset-code', async (req, res) => {
  try {
    const { code, email } = req.body;

    if (!code || !email) {
      return res.status(400).json({
        message: 'Código e email são obrigatórios',
        success: false
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({
        message: 'Código inválido ou expirado',
        success: false
      });
    }

    const resetCodeDoc = await ResetCode.findOne({
      user: user._id,
      code: code
    });

    if (!resetCodeDoc) {
      return res.status(400).json({
        valid: false,
        message: 'Código inválido ou expirado',
        success: false
      });
    }

    res.json({
      valid: true,
      message: 'Código válido',
      success: true
    });
  } catch (error) {
    console.error('Code verification error:', error);
    res.status(500).json({
      message: 'Erro ao verificar código',
      success: false
    });
  }
});

module.exports = router;