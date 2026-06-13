// src/handlers/metaHandler.js
const supabase = require('../config/supabase');

// ============================================================
// /meta — Iniciar fluxo de definição de meta
// ============================================================
async function handleDefinirMeta(ctx) {
  // Buscar categorias disponíveis
  const { data: categorias } = await supabase
    .from('categorias')
    .select('id, nome, emoji')
    .eq('padrao', true)
    .eq('ativo', true)
    .order('nome');

  if (!categorias || categorias.length === 0) {
    await ctx.reply('🦙 Nenhuma categoria encontrada!');
    return;
  }

  // Montar botões de categorias (3 por linha)
  const botoes = [];
  for (let i = 0; i < categorias.length; i += 3) {
    const linha = categorias.slice(i, i + 3).map(c => ({
      text: `${c.emoji} ${c.nome}`,
      callback_data: `meta_cat_${c.id}`
    }));
    botoes.push(linha);
  }

  await ctx.reply(
    `🎯 Definir meta mensal\n\nEscolha a categoria:`,
    {
      reply_markup: { inline_keyboard: botoes }
    }
  );
}

// ============================================================
// /metas — Ver todas as metas do mês
// ============================================================
async function handleVerMetas(ctx) {
  const usuarioId = ctx.usuario.id;
  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

  const { data: metas } = await supabase
    .from('metas')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('mes', mes)
    .eq('ano', ano);

  if (!metas || metas.length === 0) {
    await ctx.reply(
      `🎯 Nenhuma meta definida para este mes.\n\nUse /meta para criar uma!`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '➕ Criar meta', callback_data: 'meta_criar' }
          ]]
        }
      }
    );
    return;
  }

  // Buscar gastos do mês por categoria
  const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimMes = new Date(ano, mes, 0).toISOString().split('T')[0];

  const { data: gastos } = await supabase
    .from('transacoes')
    .select('categoria_id, valor')
    .eq('usuario_id', usuarioId)
    .eq('tipo', 'gasto')
    .eq('cancelado', false)
    .gte('data_transacao', inicioMes)
    .lte('data_transacao', fimMes);

  // Somar gastos por categoria
  const gastosPorCategoria = {};
  gastos?.forEach(t => {
    if (!gastosPorCategoria[t.categoria_id]) gastosPorCategoria[t.categoria_id] = 0;
    gastosPorCategoria[t.categoria_id] += parseFloat(t.valor);
  });

  const nomeMes = agora.toLocaleString('pt-BR', { month: 'long' });
  let resposta = `🎯 Metas de ${nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)}\n\n`;

  metas.forEach(meta => {
    const gasto = gastosPorCategoria[meta.categoria_id] || 0;
    const limite = parseFloat(meta.valor_limite);
    const percentual = Math.round((gasto / limite) * 100);
    const emoji = meta.categorias?.emoji || '📌';
    const nome = meta.categorias?.nome || 'Outros';

    // Barra de progresso
    const barraTotal = 10;
    const barraPreenchida = Math.min(Math.round((percentual / 100) * barraTotal), barraTotal);
    const barra = '█'.repeat(barraPreenchida) + '░'.repeat(barraTotal - barraPreenchida);

    // Status
    let status = '✅';
    if (percentual >= 100) status = '🚨';
    else if (percentual >= 80) status = '⚠️';

    resposta += `${status} ${emoji} ${nome}\n`;
    resposta += `${barra} ${percentual}%\n`;
    resposta += `R$ ${gasto.toFixed(2)} de R$ ${limite.toFixed(2)}\n\n`;
  });

  await ctx.reply(resposta, {
    reply_markup: {
      inline_keyboard: [[
        { text: '➕ Nova meta', callback_data: 'meta_criar' }
      ]]
    }
  });
}

// ============================================================
// CALLBACK: escolha de categoria e valor
// ============================================================
const sessoesMeta = new Map();

async function handleCallbackMeta(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;

  await ctx.answerCbQuery();

  // Botão "Criar meta" no /metas
  if (data === 'meta_criar') {
    await handleDefinirMeta(ctx);
    return;
  }

  // Escolheu categoria
  if (data.startsWith('meta_cat_')) {
    const categoriaId = data.replace('meta_cat_', '');

    // Buscar nome da categoria
    const { data: cat } = await supabase
      .from('categorias')
      .select('nome, emoji')
      .eq('id', categoriaId)
      .single();

    sessoesMeta.set(String(usuarioId), {
      categoriaId,
      etapa: 'aguardando_valor',
      timestamp: Date.now()
    });

    await ctx.reply(
      `${cat?.emoji || '🎯'} Meta para ${cat?.nome || 'categoria'}\n\nQual o limite mensal em reais?\n\nExemplo: 300 ou 150,50`
    );
    return;
  }
}

// ============================================================
// HANDLER TEXTO durante fluxo de meta
// ============================================================
async function handleTextoMeta(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = sessoesMeta.get(String(usuarioId));

  if (!sessao) return false;
  if (Date.now() - sessao.timestamp > 5 * 60 * 1000) {
    sessoesMeta.delete(String(usuarioId));
    return false;
  }

  if (sessao.etapa !== 'aguardando_valor') return false;

  // Interpretar valor
  const texto = ctx.message.text.replace(',', '.');
  const valor = parseFloat(texto);

  if (isNaN(valor) || valor <= 0) {
    await ctx.reply('Por favor, digite um valor valido. Exemplo: 300 ou 150,50');
    return true;
  }

  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

  // Salvar ou atualizar meta
  const { data: existente } = await supabase
    .from('metas')
    .select('id')
    .eq('usuario_id', usuarioId)
    .eq('categoria_id', sessao.categoriaId)
    .eq('mes', mes)
    .eq('ano', ano)
    .single();

  if (existente) {
    await supabase
      .from('metas')
      .update({ valor_limite: valor, alerta_80: false })
      .eq('id', existente.id);
  } else {
    await supabase
      .from('metas')
      .insert({
        usuario_id:   usuarioId,
        categoria_id: sessao.categoriaId,
        valor_limite: valor,
        mes,
        ano
      });
  }

  sessoesMeta.delete(String(usuarioId));

  // Buscar nome da categoria para confirmar
  const { data: cat } = await supabase
    .from('categorias')
    .select('nome, emoji')
    .eq('id', sessao.categoriaId)
    .single();

  await ctx.reply(
    `✅ Meta definida!\n\n${cat?.emoji || '🎯'} ${cat?.nome || 'Categoria'}: R$ ${valor.toFixed(2)}/mes\n\nVou te avisar quando atingir 80% e 100%! Use /metas para acompanhar.`
  );

  return true;
}

module.exports = {
  handleDefinirMeta,
  handleVerMetas,
  handleCallbackMeta,
  handleTextoMeta
};
