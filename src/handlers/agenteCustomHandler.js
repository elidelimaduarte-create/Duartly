// src/handlers/agenteCustomHandler.js
const supabase = require('../config/supabase');

// ============================================================
// SESSÕES EM MEMÓRIA
// ============================================================
const sessoes = new Map();

function salvarSessao(usuarioId, dados) {
  sessoes.set(String(usuarioId), { ...dados, timestamp: Date.now() });
}

function buscarSessao(usuarioId) {
  const sessao = sessoes.get(String(usuarioId));
  if (!sessao) return null;
  if (Date.now() - sessao.timestamp > 10 * 60 * 1000) {
    sessoes.delete(String(usuarioId));
    return null;
  }
  return sessao;
}

function limparSessao(usuarioId) {
  sessoes.delete(String(usuarioId));
}

// ============================================================
// /agente — Menu principal
// ============================================================
async function handleAgente(ctx) {
  const usuarioId = ctx.usuario.id;

  // Contar agentes ativos
  const { data: agentes } = await supabase
    .from('agentes_customizados')
    .select('id')
    .eq('usuario_id', usuarioId)
    .eq('ativo', true);

  const qtd = agentes?.length || 0;

  await ctx.reply(
    `🤖 Agentes Customizados\n\n` +
    `Voce tem ${qtd} agente${qtd !== 1 ? 's' : ''} ativo${qtd !== 1 ? 's' : ''}.\n\n` +
    `O que deseja fazer?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Criar novo agente', callback_data: 'ac_criar' }],
          [{ text: '📋 Ver meus agentes', callback_data: 'ac_listar' }],
        ]
      }
    }
  );
}

// ============================================================
// LISTAR AGENTES
// ============================================================
async function listarAgentes(ctx) {
  const usuarioId = ctx.usuario.id;

  const { data: agentes } = await supabase
    .from('agentes_customizados')
    .select('*')
    .eq('usuario_id', usuarioId)
    .order('criado_em', { ascending: false });

  if (!agentes || agentes.length === 0) {
    await ctx.reply(
      `🤖 Voce ainda nao tem agentes customizados.\n\nCrie um com /agente!`
    );
    return;
  }

  let resposta = `🤖 Seus Agentes\n${'─'.repeat(24)}\n\n`;

  agentes.forEach((ag, i) => {
    const status = ag.ativo ? '🟢' : '🔴';
    const tipo = formatarTipo(ag.tipo);
    const desc = formatarDescricao(ag);

    resposta += `${status} ${ag.nome}\n`;
    resposta += `📌 ${tipo}\n`;
    resposta += `⚙️ ${desc}\n\n`;
  });

  // Botões para gerenciar
  const botoes = agentes.map(ag => ([{
    text: `${ag.ativo ? '⏸ Pausar' : '▶️ Ativar'} ${ag.nome}`,
    callback_data: `ac_toggle_${ag.id}`
  }]));

  botoes.push([{ text: '➕ Criar novo', callback_data: 'ac_criar' }]);

  await ctx.reply(resposta, {
    reply_markup: { inline_keyboard: botoes }
  });
}

// ============================================================
// CRIAR AGENTE — Escolher tipo
// ============================================================
async function criarAgente(ctx) {
  await ctx.reply(
    `🤖 Criar agente customizado\n\nQual tipo de agente voce quer?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔔 Alerta de categoria', callback_data: 'ac_tipo_alerta_categoria' }],
          [{ text: '📊 Relatorio agendado', callback_data: 'ac_tipo_relatorio_agendado' }],
          [{ text: '💸 Alerta de gasto alto', callback_data: 'ac_tipo_alerta_gasto_alto' }],
          [{ text: '⏰ Lembrete de registro', callback_data: 'ac_tipo_lembrete_registro' }],
        ]
      }
    }
  );
}

// ============================================================
// FLUXO POR TIPO
// ============================================================
async function iniciarFluxoTipo(ctx, tipo) {
  const usuarioId = ctx.usuario.id;

  if (tipo === 'alerta_categoria') {
    // Buscar categorias
    const { data: categorias } = await supabase
      .from('categorias')
      .select('id, nome, emoji')
      .eq('padrao', true)
      .eq('ativo', true)
      .order('nome');

    const botoes = [];
    for (let i = 0; i < categorias.length; i += 3) {
      const linha = categorias.slice(i, i + 3).map(c => ({
        text: `${c.emoji} ${c.nome}`,
        callback_data: `ac_cat_${c.id}`
      }));
      botoes.push(linha);
    }

    salvarSessao(usuarioId, { tipo, etapa: 'escolher_categoria' });

    await ctx.reply(
      `🔔 Alerta de categoria\n\nQual categoria monitorar?`,
      { reply_markup: { inline_keyboard: botoes } }
    );

  } else if (tipo === 'relatorio_agendado') {
    salvarSessao(usuarioId, { tipo, etapa: 'escolher_frequencia' });

    await ctx.reply(
      `📊 Relatorio agendado\n\nCom que frequencia?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Todo dia', callback_data: 'ac_freq_diario' }],
            [{ text: '📅 Toda segunda-feira', callback_data: 'ac_freq_semanal' }],
            [{ text: '📅 Todo dia 1', callback_data: 'ac_freq_mensal' }],
          ]
        }
      }
    );

  } else if (tipo === 'alerta_gasto_alto') {
    salvarSessao(usuarioId, { tipo, etapa: 'aguardando_valor_gasto' });

    await ctx.reply(
      `💸 Alerta de gasto alto\n\n` +
      `Me aviso quando um unico gasto passar de quanto?\n\n` +
      `Exemplo: 200`
    );

  } else if (tipo === 'lembrete_registro') {
    salvarSessao(usuarioId, { tipo, etapa: 'escolher_horario' });

    await ctx.reply(
      `⏰ Lembrete de registro\n\nQual horario voce quer ser lembrado?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '8h', callback_data: 'ac_hora_8' },
              { text: '12h', callback_data: 'ac_hora_12' },
              { text: '18h', callback_data: 'ac_hora_18' },
            ],
            [
              { text: '20h', callback_data: 'ac_hora_20' },
              { text: '21h', callback_data: 'ac_hora_21' },
              { text: '22h', callback_data: 'ac_hora_22' },
            ]
          ]
        }
      }
    );
  }
}

// ============================================================
// SALVAR AGENTE
// ============================================================
async function salvarAgente(ctx, usuarioId, tipo, config, nome) {
  const { error } = await supabase
    .from('agentes_customizados')
    .insert({
      usuario_id: usuarioId,
      nome,
      tipo,
      config,
      ativo: true
    });

  if (error) throw new Error(error.message);

  limparSessao(usuarioId);

  await ctx.reply(
    `✅ Agente criado!\n\n` +
    `🤖 ${nome}\n` +
    `Ja esta ativo e monitorando pra voce!\n\n` +
    `Use /agente para gerenciar seus agentes.`
  );
}

// ============================================================
// TOGGLE ATIVO/PAUSADO
// ============================================================
async function toggleAgente(ctx, agenteId) {
  const { data: agente } = await supabase
    .from('agentes_customizados')
    .select('*')
    .eq('id', agenteId)
    .single();

  if (!agente) {
    await ctx.answerCbQuery('Agente nao encontrado!');
    return;
  }

  await supabase
    .from('agentes_customizados')
    .update({ ativo: !agente.ativo })
    .eq('id', agenteId);

  await ctx.answerCbQuery(agente.ativo ? '⏸ Agente pausado!' : '▶️ Agente ativado!');
  await listarAgentes(ctx);
}

// ============================================================
// HANDLER PRINCIPAL DE CALLBACKS
// ============================================================
async function handleCallbackAgente(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  await ctx.answerCbQuery();

  if (data === 'ac_criar') {
    await criarAgente(ctx);
    return;
  }

  if (data === 'ac_listar') {
    await listarAgentes(ctx);
    return;
  }

  if (data.startsWith('ac_tipo_')) {
    const tipo = data.replace('ac_tipo_', '');
    await iniciarFluxoTipo(ctx, tipo);
    return;
  }

  // Escolheu categoria para alerta
  if (data.startsWith('ac_cat_')) {
    const categoriaId = data.replace('ac_cat_', '');
    const { data: cat } = await supabase
      .from('categorias').select('nome, emoji').eq('id', categoriaId).single();

    salvarSessao(usuarioId, {
      ...sessao,
      etapa: 'aguardando_valor_categoria',
      categoriaId,
      nomeCategoria: cat?.nome,
      emojiCategoria: cat?.emoji
    });

    await ctx.reply(
      `${cat?.emoji} Alerta para ${cat?.nome}\n\n` +
      `Me aviso quando o total mensal passar de quanto?\n\nExemplo: 300`
    );
    return;
  }

  // Escolheu frequência do relatório
  if (data.startsWith('ac_freq_')) {
    const freq = data.replace('ac_freq_', '');
    const nomes = { diario: 'Todo dia', semanal: 'Toda segunda', mensal: 'Todo dia 1' };

    salvarSessao(usuarioId, {
      ...sessao,
      etapa: 'escolher_horario_relatorio',
      frequencia: freq
    });

    await ctx.reply(
      `📊 Relatorio ${nomes[freq]}\n\nQual horario?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '7h', callback_data: 'ac_hora_rel_7' },
              { text: '8h', callback_data: 'ac_hora_rel_8' },
              { text: '9h', callback_data: 'ac_hora_rel_9' },
            ],
            [
              { text: '18h', callback_data: 'ac_hora_rel_18' },
              { text: '19h', callback_data: 'ac_hora_rel_19' },
              { text: '20h', callback_data: 'ac_hora_rel_20' },
            ]
          ]
        }
      }
    );
    return;
  }

  // Horário do relatório
  if (data.startsWith('ac_hora_rel_')) {
    const hora = parseInt(data.replace('ac_hora_rel_', ''));
    const sessaoAtual = buscarSessao(usuarioId);
    const nomes = { diario: 'Todo dia', semanal: 'Toda segunda', mensal: 'Todo dia 1' };
    const nome = `Relatorio ${nomes[sessaoAtual?.frequencia] || ''} as ${hora}h`;

    await salvarAgente(ctx, usuarioId, 'relatorio_agendado', {
      frequencia: sessaoAtual?.frequencia,
      hora
    }, nome);
    return;
  }

  // Horário do lembrete
  if (data.startsWith('ac_hora_')) {
    const hora = parseInt(data.replace('ac_hora_', ''));
    await salvarAgente(ctx, usuarioId, 'lembrete_registro', { hora },
      `Lembrete de registro as ${hora}h`
    );
    return;
  }

  // Toggle ativo/pausado
  if (data.startsWith('ac_toggle_')) {
    const agenteId = data.replace('ac_toggle_', '');
    await toggleAgente(ctx, agenteId);
    return;
  }
}

// ============================================================
// HANDLER TEXTO durante fluxo de agente
// ============================================================
async function handleTextoAgente(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);
  if (!sessao) return false;

  // Valor para alerta de categoria
  if (sessao.etapa === 'aguardando_valor_categoria') {
    const valor = parseFloat(ctx.message.text.replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      await ctx.reply('Digite um valor valido. Exemplo: 300');
      return true;
    }

    await salvarAgente(ctx, usuarioId, 'alerta_categoria', {
      categoriaId: sessao.categoriaId,
      nomeCategoria: sessao.nomeCategoria,
      emojiCategoria: sessao.emojiCategoria,
      limiteReais: valor
    }, `Alerta ${sessao.emojiCategoria} ${sessao.nomeCategoria} > R$ ${valor}`);
    return true;
  }

  // Valor para alerta de gasto alto
  if (sessao.etapa === 'aguardando_valor_gasto') {
    const valor = parseFloat(ctx.message.text.replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      await ctx.reply('Digite um valor valido. Exemplo: 200');
      return true;
    }

    await salvarAgente(ctx, usuarioId, 'alerta_gasto_alto', {
      limiteReais: valor
    }, `Alerta gasto > R$ ${valor}`);
    return true;
  }

  return false;
}

// ============================================================
// HELPERS
// ============================================================
function formatarTipo(tipo) {
  const tipos = {
    alerta_categoria:   '🔔 Alerta de categoria',
    relatorio_agendado: '📊 Relatorio agendado',
    alerta_gasto_alto:  '💸 Alerta de gasto alto',
    lembrete_registro:  '⏰ Lembrete de registro',
  };
  return tipos[tipo] || tipo;
}

function formatarDescricao(agente) {
  const c = agente.config;
  switch (agente.tipo) {
    case 'alerta_categoria':
      return `Avisa quando ${c.emojiCategoria} ${c.nomeCategoria} passar de R$ ${c.limiteReais}`;
    case 'relatorio_agendado':
      return `${c.frequencia === 'diario' ? 'Todo dia' : c.frequencia === 'semanal' ? 'Toda segunda' : 'Todo dia 1'} as ${c.hora}h`;
    case 'alerta_gasto_alto':
      return `Avisa quando um gasto passar de R$ ${c.limiteReais}`;
    case 'lembrete_registro':
      return `Lembrete todo dia as ${c.hora}h`;
    default:
      return '';
  }
}

module.exports = {
  handleAgente,
  handleCallbackAgente,
  handleTextoAgente
};
