// server.js

// 1. IMPORTAÇÕES DOS MÓDULOS PRINCIPAIS E DE AMBIENTE
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
        origin: "*", // Em produção, mude para o domínio do seu frontend
        methods: ["GET", "POST", "PUT", "DELETE"] 
    }
});

// 5. MIDDLEWARES GLOBAIS DO EXPRESS
// Habilita o CORS para todas as requisições da API
// DEPOIS
app.use(cors({
  origin: "*", // Para produção, troque "*" pela URL do seu frontend: "https://seu-site.com"
  methods: "GET,POST,PUT,DELETE,PATCH,OPTIONS", // Métodos permitidos
  allowedHeaders: "Content-Type, Authorization" // Headers permitidos (ESTA É A PARTE MAIS IMPORTANTE)
}));
// Habilita o parsing de JSON no corpo das requisições
app.use(express.json());

// 6. CONEXÃO COM O BANCO DE DADOS MONGODB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Conectado ao MongoDB Atlas'))
    .catch((err) => console.error('❌ Erro ao conectar ao MongoDB:', err));

// 7. INTEGRAÇÃO DOS MÓDULOS DE ROTAS E SOCKET
// Monta todas as nossas rotas da API sob o prefixo /api
// Ex: A rota /auth/login em routes.js se torna /api/auth/login
app.use('/api', apiRoutes);

// Passa a instância do `io` para o nosso módulo de jogo, que vai configurar todos os eventos
initializeSocket(io);

// Rota de teste para verificar se o servidor HTTP está no ar
app.get('/', (req, res) => {
    res.send('Servidor da Plataforma de Damas Online está funcionando!');
});

// 8. INICIALIZAÇÃO DO SERVIDOR
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
