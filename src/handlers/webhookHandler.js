// src/handlers/webhookHandler.js
const supabase = require('../config/supabase');
const { ativarAssinatura } = require('../services/assinaturaService');

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PLAN_ID = process.env.MP_PLAN_ID;

// ============================================================
// VERIFICAR PAGAMENTO NO MERCADO PAGO
// ============================================================
async function buscarPagamentoMP(paymentId) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!response.ok) throw new Error(`MP API error: ${response.status}`);
  return await response.json();
}

async function buscarAssinaturaMP(subscriptionId) {
  const response = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
  });
  if (!response.ok) throw new Error(`MP API error: ${response.status}`);
  return await response.json();
}

// ============================================================
// BUSCAR USUÁRIO PELO EXTERNAL REFERENCE
// O external_reference é o telegram_id do usuário
// ============================================================
async function buscarUsuarioPorTelegramId(telegramId) {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

async function buscarUsuarioPorEmail(email) {
  // Fallback: buscar por email se não tiver telegram_id
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email)
    .single();
  return data;
}

// ============================================================
// PROCESSAR WEBHOOK DO MERCADO PAGO
// ============================================================
async function processarWebhook(req, res, bot) {
  try {
    const { type, data } = req.body;
    console.log(`Webhook MP recebido: ${type}`, data);

    // Responde imediatamente para o MP não reenviar
    res.status(200).json({ received: true });

    // Processar de forma assíncrona
    if (type === 'payment') {
      await processarPagamento(data.id, bot);
    } else if (type === 'subscription_preapproval') {
      await processarAssinatura(data.id, bot);
    }

  } catch (err) {
    console.error('Erro no webhook MP:', err);
    res.status(200).json({ received: true }); // Sempre 200 para o MP
  }
}

// ============================================================
// PROCESSAR PAGAMENTO APROVADO
// ============================================================
async function processarPagamento(paymentId, bot) {
  try {
    const pagamento = await buscarPagamentoMP(paymentId);
    console.log(`Pagamento ${paymentId}: ${pagamento.status}`);

    if (pagamento.status !== 'approved') return;

    // Buscar usuário pelo external_reference (telegram_id)
    let usuario = null;
    if (pagamento.external_reference) {
      usuario = await buscarUsuarioPorTelegramId(parseInt(pagamento.external_reference));
    }

    // Fallback: buscar por email do pagador
    if (!usuario && pagamento.payer?.email) {
      usuario = await buscarUsuarioPorEmail(pagamento.payer.email);
    }

    if (!usuario) {
      console.error(`Usuário não encontrado para pagamento ${paymentId}`);
      return;
    }

    // Ativar assinatura
    const { novaExpiracao } = await ativarAssinatura(usuario.id, String(paymentId));

    // Notificar usuário no Telegram
    await bot.telegram.sendMessage(
      usuario.telegram_id,
      `🎉 Pagamento confirmado!\n\n` +
      `✅ Sua assinatura Duartly Premium está ativa!\n` +
      `📅 Válida até: ${novaExpiracao.toLocaleDateString('pt-BR')}\n\n` +
      `Obrigado por assinar! Sua lhama financeira está pronta. 🦙\n\n` +
      `Use /dashboard para ver seu painel completo.`
    );

    console.log(`✅ Assinatura ativada para ${usuario.nome} (${usuario.telegram_id})`);

  } catch (err) {
    console.error(`Erro ao processar pagamento ${paymentId}:`, err);
  }
}

// ============================================================
// PROCESSAR ASSINATURA (renovação automática)
// ============================================================
async function processarAssinatura(subscriptionId, bot) {
  try {
    const assinatura = await buscarAssinaturaMP(subscriptionId);
    console.log(`Assinatura ${subscriptionId}: ${assinatura.status}`);

    if (assinatura.status !== 'authorized') return;

    // Buscar usuário pelo external_reference
    let usuario = null;
    if (assinatura.external_reference) {
      usuario = await buscarUsuarioPorTelegramId(parseInt(assinatura.external_reference));
    }

    if (!usuario) {
      console.error(`Usuário não encontrado para assinatura ${subscriptionId}`);
      return;
    }

    // Renovar assinatura
    const { novaExpiracao } = await ativarAssinatura(usuario.id, subscriptionId);

    await bot.telegram.sendMessage(
      usuario.telegram_id,
      `🔄 Assinatura renovada!\n\n` +
      `✅ Duartly Premium ativo por mais 30 dias\n` +
      `📅 Válida até: ${novaExpiracao.toLocaleDateString('pt-BR')}\n\n` +
      `Sua lhama continua trabalhando por você! 🦙`
    );

  } catch (err) {
    console.error(`Erro ao processar assinatura ${subscriptionId}:`, err);
  }
}

module.exports = { processarWebhook };
