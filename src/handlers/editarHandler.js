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
// /editar — Listar lançamentos recentes
// ============================================================
async function handleEditar(ctx) {
  const usuarioId = ctx.usuario.id;

  await ctx.reply(
    `✏️ Gerenciar lancamentos\n\nO que voce quer fazer?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🕐 Ver ultimos lancamentos', callback_data: 'editar_listar_recentes' }],
          [{ text: '🔍 Buscar por descricao', callback_data: 'editar_buscar' }],
          [{ text: '📅 Buscar por data', callback_data: 'editar_buscar_data' }],
          [{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }],
        ]
      }
    }
  );
}

// ============================================================
// CALLBACK PRINCIPAL
// ============================================================
async function handleCallbackEditar(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;

  await ctx.answerCbQuery();

  // ── CANCELAR
  if (data === 'editar_cancelar') {
    await ctx.editMessageText('🦙 Operacao cancelada!');
    limparSessao(usuarioId);
    return;
  }

  // ── LISTAR RECENTES
  if (data === 'editar_listar_recentes') {
    const { data: transacoes } = await supabase
      .from('transacoes').select('*, categorias(nome, emoji)')
      .eq('usuario_id', usuarioId).eq('cancelado', false)
      .order('criado_em', { ascending: false }).limit(8);

    if (!transacoes || transacoes.length === 0) {
      await ctx.editMessageText('🦙 Nenhum lancamento encontrado!');
      return;
    }

    await ctx.editMessageText(
      `✏️ Ultimos lancamentos:\n\n💳 = parcelamento`,
      { reply_markup: { inline_keyboard: montarBotoesTransacoes(transacoes) } }
    );
    return;
  }

  // ── BUSCAR POR DESCRIÇÃO
  if (data === 'editar_buscar') {
    salvarSessao(usuarioId, { etapa: 'aguardando_busca_descricao' });
    await ctx.editMessageText(
      `🔍 Digite o nome do lancamento que quer buscar:\n\nEx: "iFood", "Nike", "Mercado"`
    );
    return;
  }

  // ── BUSCAR POR DATA
  if (data === 'editar_buscar_data') {
    salvarSessao(usuarioId, { etapa: 'aguardando_busca_data' });
    await ctx.editMessageText(
      `📅 Digite a data do lancamento:\n\nFormatos aceitos:\n"15/05" ou "15/05/2026"`
    );
    return;
  }

  // ── SELECIONOU UM LANÇAMENTO
  if (data.startsWith('editar_sel_')) {
    const transacaoId = data.replace('editar_sel_', '');

    const { data: transacao } = await supabase
      .from('transacoes')
      .select('*, categorias(nome, emoji)')
      .eq('id', transacaoId)
      .single();

    if (!transacao) {
      await ctx.editMessageText('🦙 Lancamento nao encontrado!');
      return;
    }

    salvarSessao(usuarioId, { etapa: 'menu_acao', transacaoId, transacao });

    const emoji = transacao.categorias?.emoji || '📌';
    const valor = parseFloat(transacao.valor).toFixed(2).replace('.', ',');
    const ehParcela = !!transacao.grupo_parcela;

    // Contar parcelas restantes
    let infoExtra = '';
    let parcelasRestantes = 0;
    if (ehParcela) {
      const { data: parcelas } = await supabase
        .from('transacoes').select('id').eq('grupo_parcela', transacao.grupo_parcela).eq('cancelado', false);
      parcelasRestantes = parcelas?.length || 0;
      infoExtra = `\n📦 ${parcelasRestantes} parcelas restantes`;
    }

    const botoes = [
      [{ text: '✏️ Editar valor/descricao', callback_data: `editar_valor_${transacaoId}` }],
    ];

    if (ehParcela) {
      botoes.push([{ text: '⚡ Amortizar (antecipar parcelas)', callback_data: `editar_amortizar_${transacaoId}` }]);
      botoes.push([{ text: '🗑️ Excluir parcelas futuras', callback_data: `editar_excluir_futuras_${transacaoId}` }]);
      botoes.push([{ text: '💥 Excluir TODAS as parcelas', callback_data: `editar_excluir_todas_${transacaoId}` }]);
    } else {
      botoes.push([{ text: '🗑️ Excluir este lancamento', callback_data: `editar_excluir_simples_${transacaoId}` }]);
    }

    botoes.push([{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]);

    await ctx.editMessageText(
      `${emoji} ${transacao.descricao.replace(/\s*\(\d+\/\d+\)/, '')}\n` +
      `💰 R$ ${valor}/parcela${infoExtra}\n\n` +
      `O que deseja fazer?`,
      { reply_markup: { inline_keyboard: botoes } }
    );
    return;
  }

  // ── EDITAR VALOR
  if (data.startsWith('editar_valor_')) {
    const transacaoId = data.replace('editar_valor_', '');
    const sessao = buscarSessao(usuarioId);

    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_novo_valor', transacaoId });

    await ctx.editMessageText(
      `✏️ Digite o novo valor ou descricao:\n\n` +
      `"25" → muda so o valor\n` +
      `"Padaria 25" → muda descricao e valor`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]] } }
    );
    return;
  }

  // ── AMORTIZAR PARCELAS
  if (data.startsWith('editar_amortizar_')) {
    const transacaoId = data.replace('editar_amortizar_', '');
    const sessao = buscarSessao(usuarioId);
    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_amortizacao', transacaoId });

    const { data: transacao } = await supabase
      .from('transacoes').select('grupo_parcela').eq('id', transacaoId).single();

    const { data: parcelas } = await supabase
      .from('transacoes').select('id, data_transacao').eq('grupo_parcela', transacao.grupo_parcela)
      .eq('cancelado', false).order('data_transacao', { ascending: true });

    const restantes = parcelas?.length || 0;

    // Gerar opções de amortização
    const opcoes = [];
    for (let i = 1; i < restantes; i++) {
      opcoes.push([{
        text: `Antecipar ${i} parcela${i > 1 ? 's' : ''} (ficam ${restantes - i} restantes)`,
        callback_data: `editar_amort_qtd_${transacaoId}_${i}`
      }]);
    }
    opcoes.push([{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]);

    await ctx.editMessageText(
      `⚡ Amortizacao — ${restantes} parcelas restantes\n\nQuantas parcelas deseja antecipar?`,
      { reply_markup: { inline_keyboard: opcoes.slice(0, 6) } }
    );
    return;
  }

  // ── CONFIRMAR AMORTIZAÇÃO
  if (data.startsWith('editar_amort_qtd_')) {
    const partes = data.replace('editar_amort_qtd_', '').split('_');
    const transacaoId = partes[0];
    const qtdAntecipar = parseInt(partes[1]);

    const { data: transacao } = await supabase
      .from('transacoes').select('grupo_parcela').eq('id', transacaoId).single();

    // Buscar parcelas futuras ordenadas por data
    const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: parcelas } = await supabase
      .from('transacoes').select('id, data_transacao, valor').eq('grupo_parcela', transacao.grupo_parcela)
      .eq('cancelado', false).gte('data_transacao', hoje).order('data_transacao', { ascending: true });

    if (!parcelas || parcelas.length === 0) {
      await ctx.editMessageText('🦙 Nenhuma parcela futura encontrada!');
      return;
    }

    // Cancelar as primeiras N parcelas (antecipadas)
    const idsAntecipar = parcelas.slice(0, qtdAntecipar).map(p => p.id);
    const valorTotal = parcelas.slice(0, qtdAntecipar).reduce((a, p) => a + parseFloat(p.valor), 0);

    await supabase.from('transacoes').update({ cancelado: true }).in('id', idsAntecipar);

    limparSessao(usuarioId);
    await ctx.editMessageText(
      `✅ Amortizacao realizada!\n\n` +
      `⚡ ${qtdAntecipar} parcela(s) antecipada(s)\n` +
      `💰 Total antecipado: R$ ${valorTotal.toFixed(2)}\n` +
      `📦 ${parcelas.length - qtdAntecipar} parcelas restantes\n\n` +
      `Use /parcelas para ver o saldo atualizado.`
    );
    return;
  }

  // ── EXCLUIR PARCELAS FUTURAS
  if (data.startsWith('editar_excluir_futuras_')) {
    const transacaoId = data.replace('editar_excluir_futuras_', '');

    await ctx.editMessageText(
      `🗑️ Confirma excluir as parcelas FUTURAS?\n\nAs parcelas ja pagas serao mantidas.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Sim, excluir futuras', callback_data: `editar_conf_futuras_${transacaoId}` }],
            [{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]
          ]
        }
      }
    );
    return;
  }

  // ── CONFIRMAR EXCLUSÃO DE PARCELAS FUTURAS
  if (data.startsWith('editar_conf_futuras_')) {
    const transacaoId = data.replace('editar_conf_futuras_', '');

    const { data: transacao } = await supabase
      .from('transacoes').select('grupo_parcela').eq('id', transacaoId).single();

    const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: futuras } = await supabase
      .from('transacoes').select('id').eq('grupo_parcela', transacao.grupo_parcela)
      .eq('cancelado', false).gt('data_transacao', hoje);

    if (futuras && futuras.length > 0) {
      await supabase.from('transacoes').update({ cancelado: true }).in('id', futuras.map(p => p.id));
    }

    limparSessao(usuarioId);
    await ctx.editMessageText(
      `✅ ${futuras?.length || 0} parcelas futuras excluidas!\n\nAs parcelas anteriores foram mantidas.`
    );
    return;
  }

  // ── EXCLUIR TODAS AS PARCELAS
  if (data.startsWith('editar_excluir_todas_')) {
    const transacaoId = data.replace('editar_excluir_todas_', '');

    await ctx.editMessageText(
      `💥 Confirma excluir TODAS as parcelas?\n\nIsso nao pode ser desfeito!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💥 Sim, excluir tudo', callback_data: `editar_conf_todas_${transacaoId}` }],
            [{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]
          ]
        }
      }
    );
    return;
  }

  // ── CONFIRMAR EXCLUSÃO DE TODAS AS PARCELAS
  if (data.startsWith('editar_conf_todas_')) {
    const transacaoId = data.replace('editar_conf_todas_', '');

    const { data: transacao } = await supabase
      .from('transacoes').select('grupo_parcela').eq('id', transacaoId).single();

    await supabase.from('transacoes').update({ cancelado: true }).eq('grupo_parcela', transacao.grupo_parcela);

    limparSessao(usuarioId);
    await ctx.editMessageText('✅ Todas as parcelas foram excluidas!');
    return;
  }

  // ── EXCLUIR LANÇAMENTO SIMPLES
  if (data.startsWith('editar_excluir_simples_')) {
    const transacaoId = data.replace('editar_excluir_simples_', '');

    await ctx.editMessageText(
      `🗑️ Confirma excluir este lancamento?\n\nIsso nao pode ser desfeito!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑️ Sim, excluir', callback_data: `editar_conf_simples_${transacaoId}` }],
            [{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]
          ]
        }
      }
    );
    return;
  }

  // ── CONFIRMAR EXCLUSÃO SIMPLES
  if (data.startsWith('editar_conf_simples_')) {
    const transacaoId = data.replace('editar_conf_simples_', '');
    await supabase.from('transacoes').update({ cancelado: true }).eq('id', transacaoId);
    limparSessao(usuarioId);
    await ctx.editMessageText('✅ Lancamento excluido com sucesso!');
    return;
  }

  // ── CONFIRMAR EDIÇÃO DE VALOR
  if (data.startsWith('editar_confirmar_')) {
    const transacaoId = data.replace('editar_confirmar_', '');
    const sessao = buscarSessao(usuarioId);

    if (!sessao?.novaClassificacao) {
      await ctx.answerCbQuery('Sessao expirada!');
      return;
    }

    const { novaClassificacao } = sessao;

    const { data: categorias } = await supabase
      .from('categorias').select('id, nome')
      .or(`usuario_id.eq.${usuarioId},padrao.eq.true`)
      .ilike('nome', novaClassificacao.categoria);

    const categoriaId = categorias?.[0]?.id || null;

    const { data: transacaoAtualizada } = await supabase
      .from('transacoes').select('grupo_parcela').eq('id', transacaoId).single();

    if (transacaoAtualizada?.grupo_parcela) {
      const { data: todasParcelas } = await supabase
        .from('transacoes').select('id').eq('grupo_parcela', transacaoAtualizada.grupo_parcela).eq('cancelado', false);

      const totalParcelas = todasParcelas?.length || 1;
      const valorPorParcela = parseFloat((novaClassificacao.valor / totalParcelas).toFixed(2));

      await supabase.from('transacoes').update({
        valor: valorPorParcela,
        categoria_id: categoriaId,
        atualizado_em: new Date().toISOString()
      }).eq('grupo_parcela', transacaoAtualizada.grupo_parcela);
    } else {
      await supabase.from('transacoes').update({
        descricao: novaClassificacao.descricao,
        valor: novaClassificacao.valor,
        categoria_id: categoriaId,
        atualizado_em: new Date().toISOString()
      }).eq('id', transacaoId);
    }

    limparSessao(usuarioId);
    const emoji = novaClassificacao.categoria === 'Receita' ? '💵' : '💸';
    await ctx.editMessageText(
      `✅ Lancamento atualizado!\n\n${emoji} ${novaClassificacao.descricao}\n💰 R$ ${novaClassificacao.valor.toFixed(2)}\n🏷️ ${novaClassificacao.categoria}`
    );
    return;
  }
}

// ============================================================
// HELPER — Montar botões de transações
// ============================================================
function montarBotoesTransacoes(transacoes) {
  const vistos = new Set();
  const unicos = transacoes.filter(t => {
    if (t.grupo_parcela) {
      if (vistos.has(t.grupo_parcela)) return false;
      vistos.add(t.grupo_parcela);
    }
    return true;
  });

  const botoes = unicos.slice(0, 6).map(t => {
    const emoji = t.categorias?.emoji || '📌';
    const desc = t.descricao.replace(/\s*\(\d+\/\d+\)/, '').substring(0, 18);
    const valor = parseFloat(t.valor).toFixed(2).replace('.', ',');
    const data = t.data_transacao ? t.data_transacao.split('-').reverse().slice(0, 2).join('/') : '';
    const ehParcela = t.grupo_parcela ? '💳 ' : '';
    return [{
      text: `${ehParcela}${emoji} ${desc} ${data} R$${valor}`,
      callback_data: `editar_sel_${t.id}`
    }];
  });

  botoes.push([{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]);
  return botoes;
}

// ============================================================
// HANDLER TEXTO durante edição
// ============================================================
async function handleTextoEditar(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  if (!sessao) return false;

  // ── BUSCA POR DESCRIÇÃO
  if (sessao.etapa === 'aguardando_busca_descricao') {
    const busca = ctx.message.text;
    const { data: transacoes } = await supabase
      .from('transacoes').select('*, categorias(nome, emoji)')
      .eq('usuario_id', usuarioId).eq('cancelado', false)
      .ilike('descricao', `%${busca}%`)
      .order('data_transacao', { ascending: false }).limit(8);

    if (!transacoes || transacoes.length === 0) {
      await ctx.reply(
        `🦙 Nenhum lancamento encontrado com "${busca}".\n\nTenta outra palavra:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]] } }
      );
      return true;
    }

    limparSessao(usuarioId);
    await ctx.reply(
      `🔍 Resultados para "${busca}":`,
      { reply_markup: { inline_keyboard: montarBotoesTransacoes(transacoes) } }
    );
    return true;
  }

  // ── BUSCA POR DATA
  if (sessao.etapa === 'aguardando_busca_data') {
    const texto = ctx.message.text.trim();
    let dataISO;

    try {
      const partes = texto.split('/');
      const ano = partes[2] ? parseInt(partes[2]) : new Date().getFullYear();
      const mes = String(partes[1]).padStart(2, '0');
      const dia = String(partes[0]).padStart(2, '0');
      dataISO = `${ano}-${mes}-${dia}`;
    } catch {
      await ctx.reply('🦙 Data invalida. Tenta: "15/05" ou "15/05/2026"');
      return true;
    }

    const { data: transacoes } = await supabase
      .from('transacoes').select('*, categorias(nome, emoji)')
      .eq('usuario_id', usuarioId).eq('cancelado', false)
      .eq('data_transacao', dataISO)
      .order('criado_em', { ascending: false });

    if (!transacoes || transacoes.length === 0) {
      await ctx.reply(
        `🦙 Nenhum lancamento em ${texto}.\n\nTenta outra data:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'editar_cancelar' }]] } }
      );
      return true;
    }

    limparSessao(usuarioId);
    await ctx.reply(
      `📅 Lancamentos em ${texto}:`,
      { reply_markup: { inline_keyboard: montarBotoesTransacoes(transacoes) } }
    );
    return true;
  }

  // ── EDIÇÃO DE VALOR
  if (sessao.etapa !== 'aguardando_novo_valor') return false;

  const texto = ctx.message.text;
  const transacaoId = sessao.transacaoId;

  const { data: transacaoAtual } = await supabase
    .from('transacoes').select('*, categorias(nome)').eq('id', transacaoId).single();

  const soNumero = parseFloat(texto.replace(',', '.'));
  let novaClassificacao;

  if (!isNaN(soNumero) && soNumero > 0 && texto.trim().match(/^[\d.,]+$/)) {
    novaClassificacao = {
      descricao: (transacaoAtual?.descricao || '').replace(/\s*\(\d+\/\d+\)/, ''),
      valor: soNumero,
      categoria: transacaoAtual?.categorias?.nome || 'Outros',
    };
  } else {
    novaClassificacao = await classificarGasto(texto);
    if (!novaClassificacao || !novaClassificacao.valor) {
      await ctx.reply('🦙 Nao entendi. Tenta: "25" para mudar o valor, ou "Padaria 25" para mudar tudo.');
      return true;
    }
  }

  salvarSessao(usuarioId, { ...sessao, etapa: 'confirmando', novaClassificacao });

  const emoji = novaClassificacao.categoria === 'Receita' ? '💵' : '💸';
  await ctx.reply(
    `Confirma a alteracao?\n\n${emoji} ${novaClassificacao.descricao}\n💰 R$ ${novaClassificacao.valor.toFixed(2)}\n🏷️ ${novaClassificacao.categoria}`,
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

module.exports = { handleEditar, handleCallbackEditar, handleTextoEditar };
