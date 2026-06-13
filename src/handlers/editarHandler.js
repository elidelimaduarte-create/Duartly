// src/handlers/editarHandler.js
const supabase = require('../config/supabase');
const { classificarGasto } = require('../services/geminiService');

const sessoesEdicao = new Map();

function salvarSessao(usuarioId, dados) {
  sessoesEdicao.set(String(usuarioId), { ...dados, timestamp: Date.now() });
}

function buscarSessao(usuarioId) {
  const s = sessoesEdicao.get(String(usuarioId));
  if (!s) return null;
  if (Date.now() - s.timestamp > 5 * 60 * 1000) {
    sessoesEdicao.delete(String(usuarioId));
    return null;
  }
  return s;
}

function limparSessao(usuarioId) {
  sessoesEdicao.delete(String(usuarioId));
}

// ============================================================
// /editar — Mostrar último lançamento para editar
// ============================================================
async function handleEditar(ctx) {
  const usuarioId = ctx.usuario.id;

  // Buscar última transação não cancelada
  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .order('criado_em', { ascending: false })
    .limit(5);

  if (!transacoes || transacoes.length === 0) {
    await ctx.reply('🦙 Nenhum lancamento encontrado para editar!');
    return;
  }

  // Filtrar parcelas — mostrar só a primeira de cada grupo
  const vistos = new Set();
  const unicos = transacoes.filter(t => {
    if (t.grupo_parcela) {
      if (vistos.has(t.grupo_parcela)) return false;
      vistos.add(t.grupo_parcela);
    }
    return true;
  });

  const botoes = unicos.slice(0, 4).map(t => {
    const emoji = t.categorias?.emoji || '📌';
    const desc = t.descricao.replace(/\s*\(\d+\/\d+\)/, '').substring(0, 20);
    const valor = parseFloat(t.valor).toFixed(2).replace('.', ',');
    return [{
      text: `${emoji} ${desc} — R$ ${valor}`,
      callback_data: `editar_sel_${t.id}`
    }];
  });

  botoes.push([{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]);

  await ctx.reply(
    `✏️ Qual lancamento voce quer editar?`,
    { reply_markup: { inline_keyboard: botoes } }
  );
}

// ============================================================
// CALLBACK — Selecionou transação para editar
// ============================================================
async function handleCallbackEditar(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;

  await ctx.answerCbQuery();

  if (data === 'editar_cancelar') {
    await ctx.editMessageText('🦙 Edicao cancelada!');
    limparSessao(usuarioId);
    return;
  }

  if (data.startsWith('editar_sel_')) {
    const transacaoId = data.replace('editar_sel_', '');

    const { data: transacao } = await supabase
      .from('transacoes')
      .select('*, categorias(nome, emoji)')
      .eq('id', transacaoId)
      .single();

    if (!transacao) {
      await ctx.answerCbQuery('Lancamento nao encontrado!');
      return;
    }

    salvarSessao(usuarioId, { etapa: 'aguardando_novo_valor', transacaoId, transacao });

    const emoji = transacao.categorias?.emoji || '📌';
    const valor = parseFloat(transacao.valor).toFixed(2).replace('.', ',');

    await ctx.editMessageText(
      `✏️ Editando:\n\n` +
      `${emoji} ${transacao.descricao}\n` +
      `💰 R$ ${valor}\n` +
      `🏷️ ${transacao.categorias?.nome || 'Outros'}\n\n` +
      `Digite o novo valor ou descricao:\n` +
      `Exemplos:\n` +
      `"25" → muda so o valor\n` +
      `"Padaria 25" → muda descricao e valor`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '❌ Cancelar', callback_data: 'editar_cancelar' }
          ]]
        }
      }
    );
    return;
  }

  if (data.startsWith('editar_confirmar_')) {
    const transacaoId = data.replace('editar_confirmar_', '');
    const sessao = buscarSessao(usuarioId);

    if (!sessao?.novaClassificacao) {
      await ctx.answerCbQuery('Sessao expirada!');
      return;
    }

    const { novaClassificacao } = sessao;

    // Buscar categoria
    const { data: categorias } = await supabase
      .from('categorias')
      .select('id, nome')
      .or(`usuario_id.eq.${usuarioId},padrao.eq.true`)
      .ilike('nome', novaClassificacao.categoria);

    const categoriaId = categorias?.[0]?.id || null;

    await supabase.from('transacoes').update({
      descricao:    novaClassificacao.descricao,
      valor:        novaClassificacao.valor,
      categoria_id: categoriaId,
      atualizado_em: new Date().toISOString()
    }).eq('id', transacaoId);

    limparSessao(usuarioId);

    const emoji = novaClassificacao.categoria === 'Receita' ? '💵' : '💸';
    await ctx.editMessageText(
      `✅ Lancamento atualizado!\n\n` +
      `${emoji} ${novaClassificacao.descricao}\n` +
      `💰 R$ ${novaClassificacao.valor.toFixed(2)}\n` +
      `🏷️ ${novaClassificacao.categoria}`
    );
    return;
  }
}

// ============================================================
// HANDLER TEXTO durante edição
// ============================================================
async function handleTextoEditar(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  if (!sessao || sessao.etapa !== 'aguardando_novo_valor') return false;

  const texto = ctx.message.text;
  const transacaoId = sessao.transacaoId;
  const transacaoAtual = sessao.transacao;

  // Se só digitou número — muda só o valor
  const soNumero = parseFloat(texto.replace(',', '.'));
  let novaClassificacao;

  if (!isNaN(soNumero) && soNumero > 0 && texto.trim().match(/^[\d.,]+$/)) {
    novaClassificacao = {
      descricao: transacaoAtual.descricao.replace(/\s*\(\d+\/\d+\)/, ''),
      valor: soNumero,
      categoria: transacaoAtual.categorias?.nome || 'Outros',
    };
  } else {
    // Classificar com IA
    novaClassificacao = await classificarGasto(texto);
    if (!novaClassificacao || !novaClassificacao.valor) {
      await ctx.reply('🦙 Nao entendi. Tenta assim: "25" para mudar o valor, ou "Padaria 25" para mudar tudo.');
      return true;
    }
  }

  salvarSessao(usuarioId, { ...sessao, etapa: 'confirmando', novaClassificacao });

  const emoji = novaClassificacao.categoria === 'Receita' ? '💵' : '💸';
  await ctx.reply(
    `Confirma a alteracao?\n\n` +
    `${emoji} ${novaClassificacao.descricao}\n` +
    `💰 R$ ${novaClassificacao.valor.toFixed(2)}\n` +
    `🏷️ ${novaClassificacao.categoria}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Confirmar', callback_data: `editar_confirmar_${transacaoId}` },
          { text: '❌ Cancelar', callback_data: 'editar_cancelar' }
        ]]
      }
    }
  );

  return true;
}

module.exports = {
  handleEditar,
  handleCallbackEditar,
  handleTextoEditar
};
