// src/handlers/onboardingHandler.js
const supabase = require('../config/supabase');

// ============================================================
// ESTADO DO ONBOARDING EM MEMÓRIA
// ============================================================
const sessoes = new Map();

function salvarSessao(usuarioId, dados) {
  sessoes.set(String(usuarioId), { ...dados, timestamp: Date.now() });
}

function buscarSessao(usuarioId) {
  const s = sessoes.get(String(usuarioId));
  if (!s) return null;
  if (Date.now() - s.timestamp > 30 * 60 * 1000) {
    sessoes.delete(String(usuarioId));
    return null;
  }
  return s;
}

function limparSessao(usuarioId) {
  sessoes.delete(String(usuarioId));
}

// ============================================================
// INICIAR ONBOARDING
// Chamado após o /start para novos usuários
// ============================================================
async function iniciarOnboarding(ctx) {
  const nome = ctx.from.first_name || 'amigo';
  const usuarioId = ctx.usuario?.id;

  salvarSessao(usuarioId, { etapa: 'passo1' });

  // Passo 1 — Apresentação
  await ctx.reply(
    `🦙 Ola, ${nome}! Sou o Duartly.\n\n` +
    `Vou te mostrar como funciona em 3 passos rapidos!\n\n` +
    `*Passo 1 de 3 — Registrar um gasto*\n\n` +
    `E simples assim: me manda uma mensagem com o gasto.\n\n` +
    `Tenta agora! Manda algo como:\n` +
    `"Cafe 8"\n` +
    `"iFood 45"\n` +
    `"Mercado 120"`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⏭ Pular tutorial', callback_data: 'onboarding_pular' }
        ]]
      }
    }
  );
}

// ============================================================
// PASSO 2 — Após primeiro gasto
// ============================================================
async function passo2(ctx) {
  const usuarioId = ctx.usuario?.id;
  salvarSessao(usuarioId, { etapa: 'passo2' });

  await ctx.reply(
    `✅ Perfeito! Voce ja sabe registrar gastos!\n\n` +
    `*Passo 2 de 3 — Consultar seus gastos*\n\n` +
    `Agora testa ver o que voce gastou hoje:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Ver gastos de hoje', callback_data: 'onboarding_hoje' }
        ], [
          { text: '⏭ Pular', callback_data: 'onboarding_passo3' }
        ]]
      }
    }
  );
}

// ============================================================
// PASSO 3 — Dashboard e finalizar
// ============================================================
async function passo3(ctx) {
  const usuarioId = ctx.usuario?.id;

  // Buscar código de convite do usuário
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('codigo_convite, trial_expira_em')
    .eq('id', usuarioId)
    .single();

  const diasTrial = usuario?.trial_expira_em
    ? Math.ceil((new Date(usuario.trial_expira_em) - new Date()) / (1000 * 60 * 60 * 24))
    : 7;

  salvarSessao(usuarioId, { etapa: 'concluido' });

  await ctx.reply(
    `🎉 Tutorial concluido!\n\n` +
    `*Passo 3 de 3 — Seus superpoderes*\n\n` +
    `Voce tambem pode:\n\n` +
    `📸 *Foto do cupom* → tiro e registro automatico\n` +
    `🎙️ *Audio* → fala o gasto e eu transcrevo\n` +
    `💳 *Parcelado* → "Nike 300 em 3x"\n` +
    `📊 */dashboard* → painel web completo\n` +
    `🎯 */meta* → definir limite por categoria\n\n` +
    `Voce tem *${diasTrial} dias gratis* para explorar tudo!\n\n` +
    `Seu codigo de convite: *${usuario?.codigo_convite || 'carregando...'}*\n` +
    `Compartilhe e ganhe 30 dias gratis por amigo que assinar! 🦙`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Ver meu dashboard', callback_data: 'onboarding_dashboard' }
        ], [
          { text: '✅ Comecar a usar!', callback_data: 'onboarding_fim' }
        ]]
      }
    }
  );
}

// ============================================================
// VERIFICAR SE DEVE MOSTRAR PASSO 2
// Chamado após registrar primeiro gasto
// ============================================================
async function verificarOnboarding(ctx) {
  const usuarioId = ctx.usuario?.id;
  const sessao = buscarSessao(usuarioId);

  if (sessao?.etapa === 'passo1') {
    setTimeout(() => passo2(ctx), 1500);
    return true;
  }
  return false;
}

// ============================================================
// HANDLER DE CALLBACKS DO ONBOARDING
// ============================================================
async function handleCallbackOnboarding(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario?.id;

  await ctx.answerCbQuery();

  if (data === 'onboarding_pular') {
    limparSessao(usuarioId);
    await ctx.editMessageText(
      `🦙 Tudo bem! Voce pode explorar por conta propria.\n\n` +
      `Use /ajuda para ver tudo que sei fazer!`
    );
    return;
  }

  if (data === 'onboarding_hoje') {
    const { handleHoje } = require('./consultaHandler');
    await ctx.deleteMessage();
    await handleHoje(ctx);
    setTimeout(() => passo3(ctx), 1000);
    return;
  }

  if (data === 'onboarding_passo3') {
    await ctx.deleteMessage();
    await passo3(ctx);
    return;
  }

  if (data === 'onboarding_dashboard') {
    const { handleDashboard } = require('./dashboardHandler');
    await ctx.deleteMessage();
    await handleDashboard(ctx);
    limparSessao(usuarioId);
    return;
  }

  if (data === 'onboarding_fim') {
    limparSessao(usuarioId);
    await ctx.editMessageText(
      `🦙 Bora! Me manda um gasto quando quiser.\n\n` +
      `Estou aqui 24h por dia cuidando do seu dinheiro!`
    );
    return;
  }
}

// ============================================================
// VERIFICAR SE É USUÁRIO NOVO (sem transações)
// ============================================================
async function ehUsuarioNovo(usuarioId) {
  const { data } = await supabase
    .from('transacoes')
    .select('id')
    .eq('usuario_id', usuarioId)
    .limit(1);
  return !data || data.length === 0;
}

module.exports = {
  iniciarOnboarding,
  verificarOnboarding,
  handleCallbackOnboarding,
  ehUsuarioNovo,
  passo2,
  passo3
};
