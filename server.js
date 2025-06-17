// server.js (com a correção do CORS)

// 1. IMPORTAÇÕES PRINCIPAIS
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// 2. IMPORTAÇÃO DOS NOSSOS MÓDULOS LOCAIS
const apiRoutes = require('./routes.js');
const initializeSocket = require('./gameSocket.js');

// 3. CONFIGURAÇÃO INICIAL DO SERVIDOR E DO EXPRESS
const app = express();
const server = http.createServer(app);

// 4. CONFIGURAÇÃO DO SOCKET.IO
const io = new Server(server, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"] 
    }
});

// 5. MIDDLEWARES GLOBAIS DO EXPRESS
// --- CORREÇÃO DO CORS APLICADA AQUI ---
app.use(cors({
  origin: "*", // Em produção, mude para a URL do seu frontend
  methods: "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  allowedHeaders: "Content-Type, Authorization"
}));
app.use(express.json());

// 6. CONEXÃO COM O BANCO DE DADOS MONGODB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Conectado ao MongoDB Atlas'))
    .catch((err) => console.error('❌ Erro ao conectar ao MongoDB:', err));

// 7. INTEGRAÇÃO DOS MÓDULOS DE ROTAS E SOCKET
app.use('/api', apiRoutes);
initializeSocket(io);

app.get('/', (req, res) => {
    res.send('Servidor da Plataforma de Damas Online está funcionando!');
});

// 8. INICIALIZAÇÃO DO SERVIDOR
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});