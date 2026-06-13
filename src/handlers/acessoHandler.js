// src/handlers/acessoHandler.js
const supabase = require('../config/supabase');
const { verificarAcesso, inicializarUsuario, criarLinkPagamento } = require('../services/assinaturaService');

// ============================================================
// MIDDLEWARE DE ACESSO
// Bloqueia usuários sem plano ativo
// ============================================================
const COMANDOS_LIVRES = ['/start', '/ajuda', '/assinar', '/convite', '/ping'];

async function middlewareAcesso(ctx, next) {
  if (!ctx.usuario) return next();

  // Comandos sempre liberados
  const texto = ctx.message?.text || ctx.callbackQuery?.data || '';
  const ehComandoLivre = COMANDOS_LIVRES.some(cmd => texto.startsWith(cmd));
  if (ehComandoLivre) return next();

  const acesso = await verificarAcesso(ctx.usuario.id);

  if (acesso.temAcesso) {
    // Avisar quando faltam 2 dias ou menos
    if (acesso.diasRestantes <= 2 && acesso.plano === 'trial') {
      await ctx.reply(
        `⚠️ Seu trial expira em ${acesso.diasRestantes} dia${acesso.diasRestantes > 1 ? 's' : ''}!\n` +
        `Use /assinar para continuar com tudo por R$ 14,90/mes.`
      );
    }
    return next();
  }

  // Sem acesso — mostrar mensagem e link
  const linkPagamento = await criarLinkPagamento(ctx.usuario);

  await ctx.reply(
    `🦙 Seu periodo gratuito encerrou!\n\n` +
    `Para continuar usando o Duartly assine por apenas:\n\n` +
    `💰 R$ 14,90/mes\n\n` +
    `Acesso a tudo:\n` +
    `✅ Registro ilimitado\n` +
    `✅ Dashboard web\n` +
    `✅ Agentes Cuzco, Luna e Inti\n` +
    `✅ Relatorio PDF\n` +
    `✅ Metas e alertas\n\n` +
    `Seu codigo de indicacao: ${ctx.usuario.codigo_convite}\n` +
    `Compartilhe e ganhe 30 dias gratis!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '💳 Assinar agora — R$ 14,90/mes', url: linkPagamento }
        ]]
      }
    }
  );
}

// ============================================================
// /assinar — Mostrar opções de assinatura
// ============================================================
async function handleAssinar(ctx) {
  const usuario = ctx.usuario;
  const acesso = await verificarAcesso(usuario.id);
  const linkPagamento = await criarLinkPagamento(usuario);

  let statusTexto = '';
  if (acesso.temAcesso && acesso.plano === 'trial') {
    statusTexto = `Voce esta no trial gratuito. Faltam ${acesso.diasRestantes} dia(s).\n\n`;
  } else if (acesso.temAcesso && acesso.plano === 'ativo') {
    statusTexto = `Sua assinatura esta ativa por mais ${acesso.diasRestantes} dia(s).\n\n`;
  }

  await ctx.reply(
    `🦙 Duartly Premium\n\n` +
    statusTexto +
    `Por apenas R$ 14,90/mes voce tem:\n\n` +
    `✅ Registro por texto, foto e audio\n` +
    `✅ Dashboard web completo\n` +
    `✅ Agentes Cuzco, Luna e Inti\n` +
    `✅ Relatorio PDF mensal\n` +
    `✅ Metas com alertas\n` +
    `✅ Parcelamentos com cartao\n` +
    `✅ Suporte incluido\n\n` +
    `Pague via PIX ou cartao de credito:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Assinar — R$ 14,90/mes', url: linkPagamento }],
          [{ text: '🎁 Tenho codigo de convite', callback_data: 'usar_convite' }]
        ]
      }
    }
  );
}

// ============================================================
// /convite — Ver e compartilhar código de convite
// ============================================================
async function handleConvite(ctx) {
  const usuario = ctx.usuario;

  if (!usuario.codigo_convite) {
    await ctx.reply('🦙 Carregando seu codigo de convite...');
    return;
  }

  // Contar quantos usaram o código
  const { data: convite } = await supabase
    .from('convites')
    .select('usos')
    .eq('codigo', usuario.codigo_convite)
    .single();

  const usos = convite?.usos || 0;
  const bonusGanho = usos * 30;

  await ctx.reply(
    `🎁 Seu codigo de convite:\n\n` +
    `*${usuario.codigo_convite}*\n\n` +
    `Compartilhe com amigos! Quando eles assinarem:\n` +
    `• Eles ganham: trial de 14 dias (dobrado!)\n` +
    `• Voce ganha: +30 dias gratis por assinante\n\n` +
    `Amigos que usaram: ${usos}\n` +
    `Dias bonus acumulados: ${bonusGanho} dias\n\n` +
    `Mensagem para compartilhar:\n` +
    `---\n` +
    `Estou usando o Duartly para controlar minhas financas com IA! Experimente 14 dias gratis com meu codigo: *${usuario.codigo_convite}*\n` +
    `Acesse: https://t.me/DuartlyBot?start=${usuario.codigo_convite}`,
    { parse_mode: 'Markdown' }
  );
}

// ============================================================
// HANDLER START com código de convite
// Chamado quando usuario acessa via link de convite
// ============================================================
async function handleStartComConvite(ctx, codigoConvite) {
  const usuario = ctx.usuario;
  const nome = ctx.from.first_name || 'amigo';

  // Verificar se já tem trial inicializado
  const { data: usuarioAtual } = await supabase
    .from('usuarios')
    .select('plano, codigo_convite, trial_expira_em')
    .eq('id', usuario.id)
    .single();

  if (usuarioAtual?.codigo_convite) {
    // Já inicializado — só mostrar boas vindas
    await ctx.reply(
      `🦙 Ola, ${nome}! Voce ja tem uma conta no Duartly.\n\n` +
      `Use /ajuda para ver tudo que sei fazer!`
    );
    return;
  }

  // Inicializar com código de convite
  const resultado = await inicializarUsuario(usuario.id, nome, codigoConvite);

  const diasTrial = resultado.diasExtra > 0 ? 14 : 7;

  await ctx.reply(
    `🦙 Bem-vindo ao Duartly, ${nome}!\n\n` +
    `${codigoConvite ? `Codigo *${codigoConvite}* aplicado! Voce ganhou ${diasTrial} dias gratis!\n\n` : ''}` +
    `Me conta um gasto e eu ja registro pra voce:\n\n` +
    `Exemplos:\n` +
    `- "Padaria 18,50"\n` +
    `- "iFood 45"\n` +
    `- "Nike 300 em 3x"\n\n` +
    `Seu trial encerra em *${diasTrial} dias*. Use /assinar para continuar depois.\n\n` +
    `Seu codigo de indicacao: *${resultado.codigo}*\n` +
    `Compartilhe e ganhe 30 dias gratis por amigo que assinar!`,
    { parse_mode: 'Markdown' }
  );
}

// ============================================================
// INICIALIZAR USUÁRIO NO /start normal (sem convite)
// ============================================================
async function handleStartNormal(ctx) {
  const usuario = ctx.usuario;
  const nome = ctx.from.first_name || 'amigo';

  const { data: usuarioAtual } = await supabase
    .from('usuarios')
    .select('codigo_convite')
    .eq('id', usuario.id)
    .single();

  if (!usuarioAtual?.codigo_convite) {
    await inicializarUsuario(usuario.id, nome);
  }

  await ctx.reply(
    `🦙 Ola, ${nome}! Sou o Duartly, sua lhama financeira pessoal.\n\n` +
    `Voce tem 7 dias gratis para experimentar!\n\n` +
    `Me conta um gasto e eu ja registro:\n` +
    `- "Padaria 18,50"\n` +
    `- "iFood 45"\n` +
    `- "Nike 300 em 3x"\n\n` +
    `Use /ajuda para ver tudo que sei fazer! 🦙`
  );
}

module.exports = {
  middlewareAcesso,
  handleAssinar,
  handleConvite,
  handleStartComConvite,
  handleStartNormal,
  handleCancelar,
  handleCallbackCancelamento
};
