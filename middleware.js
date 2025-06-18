const jwt = require('jsonwebtoken');
const { User } = require('./models');

// Middleware para verificar autenticação
exports.isAuthenticated = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        message: 'Não autorizado - Token não fornecido',
        success: false 
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      return res.status(401).json({ 
        message: 'Usuário não encontrado',
        success: false 
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({ 
        message: 'Conta bloqueada',
        success: false 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        message: 'Token inválido',
        success: false 
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: 'Token expirado',
        success: false 
      });
    }
    res.status(500).json({ 
      message: 'Erro na autenticação',
      success: false 
    });
  }
};

// Middleware para verificar se é admin
exports.isAdmin = async (req, res, next) => {
  try {
    await exports.isAuthenticated(req, res, async () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ 
          message: 'Acesso negado - Requer privilégios de administrador',
          success: false 
        });
      }
      next();
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Erro na verificação de admin',
      success: false 
    });
  }
};