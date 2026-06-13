// src/handlers/metaHandler.js
const supabase = require('../config/supabase');

// ============================================================
// /meta — Iniciar fluxo de definição de meta
// ============================================================
async function handleDefinirMeta(ctx) {
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
    { reply_markup: { inline_keyboard: botoes } }
  );
}

// ============================================================
// /metas — Ver todas as metas com visual melhorado
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

  const gastosPorCategoria = {};
  gastos?.forEach(t => {
    if (!gastosPorCategoria[t.categoria_id]) gastosPorCategoria[t.categoria_id] = 0;
    gastosPorCategoria[t.categoria_id] += parseFloat(t.valor);
  });

  const nomeMes = agora.toLocaleString('pt-BR', { month: 'long' });
  const nomeFormatado = nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1);

  let resposta = `🎯 Metas de ${nomeFormatado} ${ano}\n`;
  resposta += `${'─'.repeat(28)}\n\n`;

  // Ordenar: estouradas primeiro, depois por percentual
  const metasOrdenadas = [...metas].sort((a, b) => {
    const pctA = (gastosPorCategoria[a.categoria_id] || 0) / parseFloat(a.valor_limite);
    const pctB = (gastosPorCategoria[b.categoria_id] || 0) / parseFloat(b.valor_limite);
    return pctB - pctA;
  });

  metasOrdenadas.forEach(meta => {
    const gasto = gastosPorCategoria[meta.categoria_id] || 0;
    const limite = parseFloat(meta.valor_limite);
    const percentual = Math.min(Math.round((gasto / limite) * 100), 100);
    const emoji = meta.categorias?.emoji || '📌';
    const nome = meta.categorias?.nome || 'Outros';
    const restante = Math.max(limite - gasto, 0);

    // Status visual
    let statusEmoji = '🟢';
    let statusTexto = 'No controle';
    if (percentual >= 100) {
      statusEmoji = '🔴';
      statusTexto = 'Meta estourada!';
    } else if (percentual >= 80) {
      statusEmoji = '🟡';
      statusTexto = 'Quase no limite';
    } else if (percentual >= 50) {
      statusEmoji = '🟠';
      statusTexto = 'Metade usada';
    }

    // Barra de progresso com emojis universais
    const totalBlocos = 10;
    const blocosPreenchidos = Math.round((percentual / 100) * totalBlocos);
    let corBloco = '🟩';
    if (percentual >= 100) corBloco = '🟥';
    else if (percentual >= 80) corBloco = '🟨';
    else if (percentual >= 50) corBloco = '🟧';
    const barra = corBloco.repeat(blocosPreenchidos) + '⬜'.repeat(totalBlocos - blocosPreenchidos);

    resposta += `${statusEmoji} ${emoji} ${nome}\n`;
    resposta += `${barra} ${percentual}%\n`;
    resposta += `💸 R$ ${gasto.toFixed(2)} / R$ ${limite.toFixed(2)}\n`;

    if (percentual >= 100) {
      const excesso = gasto - limite;
      resposta += `⚠️ Excedeu R$ ${excesso.toFixed(2)}!\n`;
    } else {
      resposta += `✅ Faltam R$ ${restante.toFixed(2)}\n`;
    }

    resposta += `📌 ${statusTexto}\n\n`;
  });

  // Resumo geral
  const totalLimite = metas.reduce((a, m) => a + parseFloat(m.valor_limite), 0);
  const totalGasto = metas.reduce((a, m) => a + (gastosPorCategoria[m.categoria_id] || 0), 0);
  const pctGeral = Math.round((totalGasto / totalLimite) * 100);

  resposta += `${'─'.repeat(28)}\n`;
  resposta += `📊 Total: R$ ${totalGasto.toFixed(2)} de R$ ${totalLimite.toFixed(2)} (${pctGeral}%)`;

  await ctx.reply(resposta, {
    reply_markup: {
      inline_keyboard: [[
        { text: '➕ Nova meta', callback_data: 'meta_criar' }
      ]]
    }
  });
}

// ============================================================
// CALLBACKS
// ============================================================
const sessoesMeta = new Map();

async function handleCallbackMeta(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;

  await ctx.answerCbQuery();

  if (data === 'meta_criar') {
    await handleDefinirMeta(ctx);
    return;
  }

  if (data.startsWith('meta_cat_')) {
    const categoriaId = data.replace('meta_cat_', '');

    const { data: cat } = await supabase
      .from('categorias')
      .select('nome, emoji')
      .eq('id', categoriaId)
      .single();

    sessoesMeta.set(String(usuarioId), {
      categoriaId,
      etapa: 'aguardando_valor',
      nomeCategoria: cat?.nome || 'Categoria',
      emojiCategoria: cat?.emoji || '🎯',
      timestamp: Date.now()
    });

    await ctx.reply(
      `${cat?.emoji || '🎯'} Meta para ${cat?.nome || 'categoria'}\n\n` +
      `Qual o limite mensal em reais?\n\n` +
      `Exemplos: 200 ou 350,50`
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

  const texto = ctx.message.text.replace(',', '.');
  const valor = parseFloat(texto);

  if (isNaN(valor) || valor <= 0) {
    await ctx.reply('Por favor, digite um valor valido. Exemplo: 300 ou 150,50');
    return true;
  }

  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

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

  const nomeMes = agora.toLocaleString('pt-BR', { month: 'long' });

  await ctx.reply(
    `✅ Meta salva!\n\n` +
    `${sessao.emojiCategoria} ${sessao.nomeCategoria}\n` +
    `💰 Limite: R$ ${valor.toFixed(2)} em ${nomeMes}\n\n` +
    `Vou te avisar quando atingir 80% e quando estourar!\n` +
    `Use /metas para acompanhar o progresso.`
  );

  return true;
}

module.exports = {
  handleDefinirMeta,
  handleVerMetas,
  handleCallbackMeta,
  handleTextoMeta
};
