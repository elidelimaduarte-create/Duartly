// src/services/assinaturaService.js
const supabase = require('../config/supabase');
const crypto = require('crypto');

// ============================================================
// GERAR CÓDIGO DE CONVITE ÚNICO
// ============================================================
function gerarCodigo(nome) {
  const base = (nome || 'USER').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 6);
  const sufixo = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${base}${sufixo}`;
}

// ============================================================
// INICIALIZAR USUÁRIO NOVO
// Chamado quando usuário faz /start pela primeira vez
// ============================================================
async function inicializarUsuario(usuarioId, nomeUsuario, codigoConvite = null) {
  // Gerar código de convite único para este usuário
  let codigo;
  let tentativas = 0;
  do {
    codigo = gerarCodigo(nomeUsuario);
    const { data: existente } = await supabase
      .from('usuarios').select('id').eq('codigo_convite', codigo).single();
    if (!existente) break;
    tentativas++;
  } while (tentativas < 5);

  // Calcular expiração do trial (7 dias)
  const trialExpira = new Date();
  trialExpira.setDate(trialExpira.getDate() + 7);

  // Verificar se veio com código de convite válido
  let indicadoPor = null;
  let diasExtra = 0;

  if (codigoConvite) {
    const resultado = await validarEUsarConvite(codigoConvite, usuarioId);
    if (resultado.valido) {
      indicadoPor = resultado.donoId;
      diasExtra = 7; // indicado ganha 14 dias no total (7 + 7 extra)
      trialExpira.setDate(trialExpira.getDate() + 7);
    }
  }

  // Atualizar usuário
  await supabase.from('usuarios').update({
    plano: 'trial',
    trial_expira_em: trialExpira.toISOString(),
    codigo_convite: codigo,
    indicado_por: indicadoPor,
    dias_bonus: diasExtra
  }).eq('id', usuarioId);

  return { codigo, trialExpira, diasExtra };
}

// ============================================================
// VALIDAR E USAR CONVITE
// ============================================================
async function validarEUsarConvite(codigo, usuarioIdNovo) {
  const { data: convite } = await supabase
    .from('convites')
    .select('*, usuarios(id, nome, telegram_id)')
    .eq('codigo', codigo.toUpperCase())
    .eq('ativo', true)
    .single();

  if (!convite) return { valido: false, erro: 'Codigo invalido ou expirado' };
  if (convite.usos >= convite.limite_usos) return { valido: false, erro: 'Codigo esgotado' };

  // Incrementar uso
  await supabase.from('convites')
    .update({ usos: convite.usos + 1 })
    .eq('id', convite.id);

  return {
    valido: true,
    donoId: convite.criado_por,
    donoNome: convite.usuarios?.nome,
    donoTelegramId: convite.usuarios?.telegram_id
  };
}

// ============================================================
// VERIFICAR ACESSO
// Retorna se o usuário pode usar o bot
// ============================================================
async function verificarAcesso(usuarioId) {
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('plano, trial_expira_em, assinatura_ativa_ate, dias_bonus')
    .eq('id', usuarioId)
    .single();

  if (!usuario) return { temAcesso: false, motivo: 'usuario_nao_encontrado' };

  const agora = new Date();

  // Trial ativo
  if (usuario.plano === 'trial' && usuario.trial_expira_em) {
    const expira = new Date(usuario.trial_expira_em);
    if (agora < expira) {
      const diasRestantes = Math.ceil((expira - agora) / (1000 * 60 * 60 * 24));
      return { temAcesso: true, plano: 'trial', diasRestantes };
    } else {
      // Trial expirado — atualizar plano
      await supabase.from('usuarios').update({ plano: 'expirado' }).eq('id', usuarioId);
      return { temAcesso: false, motivo: 'trial_expirado' };
    }
  }

  // Assinatura ativa
  if (usuario.plano === 'ativo' && usuario.assinatura_ativa_ate) {
    const expira = new Date(usuario.assinatura_ativa_ate);
    if (agora < expira) {
      const diasRestantes = Math.ceil((expira - agora) / (1000 * 60 * 60 * 24));
      return { temAcesso: true, plano: 'ativo', diasRestantes };
    } else {
      await supabase.from('usuarios').update({ plano: 'expirado' }).eq('id', usuarioId);
      return { temAcesso: false, motivo: 'assinatura_expirada' };
    }
  }

  // Expirado
  return { temAcesso: false, motivo: usuario.plano === 'expirado' ? 'expirado' : 'sem_plano' };
}

// ============================================================
// ATIVAR ASSINATURA (chamado pelo webhook do Mercado Pago)
// ============================================================
async function ativarAssinatura(usuarioId, pagamentoId, meses = 1) {
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('assinatura_ativa_ate, dias_bonus, indicado_por')
    .eq('id', usuarioId)
    .single();

  // Calcular novo período
  const agora = new Date();
  const base = usuario?.assinatura_ativa_ate && new Date(usuario.assinatura_ativa_ate) > agora
    ? new Date(usuario.assinatura_ativa_ate)
    : agora;

  const novaExpiracao = new Date(base);
  novaExpiracao.setMonth(novaExpiracao.getMonth() + meses);

  // Adicionar dias bonus se houver
  if (usuario?.dias_bonus > 0) {
    novaExpiracao.setDate(novaExpiracao.getDate() + usuario.dias_bonus);
  }

  // Atualizar usuário
  await supabase.from('usuarios').update({
    plano: 'ativo',
    assinatura_ativa_ate: novaExpiracao.toISOString(),
    dias_bonus: 0 // zera após usar
  }).eq('id', usuarioId);

  // Registrar assinatura
  await supabase.from('assinaturas').insert({
    usuario_id: usuarioId,
    mp_payment_id: pagamentoId,
    status: 'active',
    valor: 14.90,
    periodo_inicio: agora.toISOString(),
    periodo_fim: novaExpiracao.toISOString()
  });

  // Recompensar quem indicou (+30 dias)
  if (usuario?.indicado_por) {
    const { data: indicador } = await supabase
      .from('usuarios')
      .select('assinatura_ativa_ate, plano, telegram_id')
      .eq('id', usuario.indicado_por)
      .single();

    if (indicador) {
      const baseIndicador = indicador.assinatura_ativa_ate && new Date(indicador.assinatura_ativa_ate) > agora
        ? new Date(indicador.assinatura_ativa_ate)
        : agora;
      const bonusIndicador = new Date(baseIndicador);
      bonusIndicador.setDate(bonusIndicador.getDate() + 30);

      await supabase.from('usuarios').update({
        plano: indicador.plano === 'expirado' ? 'ativo' : indicador.plano,
        assinatura_ativa_ate: bonusIndicador.toISOString()
      }).eq('id', usuario.indicado_por);
    }
  }

  return { novaExpiracao };
}

// ============================================================
// CRIAR LINK DE PAGAMENTO MERCADO PAGO
// ============================================================
async function criarLinkPagamento(usuario) {
  // Por enquanto retorna link fixo do Mercado Pago
  // Depois integrar com API do MP para gerar link dinâmico com usuário_id
  const params = new URLSearchParams({
    usuario_id: usuario.id,
    telegram_id: usuario.telegram_id,
    nome: usuario.nome || 'usuario'
  });

  // URL base do Mercado Pago (você vai configurar no painel do MP)
  const baseUrl = process.env.MP_CHECKOUT_URL || 'https://www.mercadopago.com.br/subscriptions/checkout';
  return `${baseUrl}?${params.toString()}`;
}

// ============================================================
// ENVIAR AVISOS DE EXPIRAÇÃO
// ============================================================
async function verificarExpiracoes(bot) {
  const agora = new Date();

  // Avisar trial expirando em 1 e 2 dias
  for (const dias of [1, 2]) {
    const limite = new Date(agora);
    limite.setDate(limite.getDate() + dias);
    const limiteFim = new Date(limite);
    limiteFim.setHours(limiteFim.getHours() + 1);

    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('*')
      .eq('plano', 'trial')
      .eq('ativo', true)
      .gte('trial_expira_em', limite.toISOString())
      .lt('trial_expira_em', limiteFim.toISOString());

    for (const usuario of (usuarios || [])) {
      try {
        const linkPagamento = await criarLinkPagamento(usuario);
        await bot.telegram.sendMessage(
          usuario.telegram_id,
          `🦙 Oi, ${usuario.nome || 'amigo'}! Seu trial do Duartly expira em ${dias} dia${dias > 1 ? 's' : ''}!\n\n` +
          `Para continuar usando todos os recursos, assine por apenas R$ 14,90/mês:\n\n` +
          `${linkPagamento}\n\n` +
          `Seu codigo de indicacao: *${usuario.codigo_convite}*\n` +
          `Compartilhe e ganhe 30 dias gratis quando um amigo assinar!`
        );
      } catch (err) {
        console.error(`Erro ao avisar expiração para ${usuario.telegram_id}:`, err);
      }
    }
  }
}

module.exports = {
  inicializarUsuario,
  validarEUsarConvite,
  verificarAcesso,
  ativarAssinatura,
  criarLinkPagamento,
  verificarExpiracoes
};
