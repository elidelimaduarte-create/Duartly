// src/handlers/contasHandler.js
const supabase = require('../config/supabase');

const sessoes = new Map();

function salvarSessao(usuarioId, dados) {
  sessoes.set(String(usuarioId), { ...dados, timestamp: Date.now() });
}

function buscarSessao(usuarioId) {
  const s = sessoes.get(String(usuarioId));
  if (!s) return null;
  if (Date.now() - s.timestamp > 10 * 60 * 1000) {
    sessoes.delete(String(usuarioId));
    return null;
  }
  return s;
}

function limparSessao(usuarioId) {
  sessoes.delete(String(usuarioId));
}

function getDataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

// ============================================================
// /contas — Menu principal
// ============================================================
async function handleContas(ctx) {
  const usuarioId = ctx.usuario.id;
  const agora = getDataBrasilia();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

  const { data: contas } = await supabase
    .from('contas_fixas')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('ativo', true)
    .order('dia_vencimento');

  if (!contas || contas.length === 0) {
    await ctx.reply(
      `📅 Contas a Pagar\n\nVoce ainda nao tem contas cadastradas.\n\nCadastre suas contas fixas e o Duartly avisa antes do vencimento!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Cadastrar conta', callback_data: 'contas_nova' }]
          ]
        }
      }
    );
    return;
  }

  // Buscar quais já foram pagas esse mês
  const { data: pagas } = await supabase
    .from('contas_pagas')
    .select('conta_id')
    .eq('usuario_id', usuarioId)
    .eq('mes', mes)
    .eq('ano', ano);

  const pagasIds = new Set(pagas?.map(p => p.conta_id) || []);

  const hoje = agora.getDate();
  let texto = `📅 Contas de ${agora.toLocaleString('pt-BR', { month: 'long' })}\n\n`;

  let totalPago = 0;
  let totalPendente = 0;

  contas.forEach(conta => {
    const paga = pagasIds.has(conta.id);
    const diasAteVencer = conta.dia_vencimento - hoje;
    const valor = conta.valor ? `R$ ${parseFloat(conta.valor).toFixed(2)}` : 'valor variavel';

    let status = '';
    if (paga) {
      status = '✅';
      totalPago += parseFloat(conta.valor || 0);
    } else if (diasAteVencer < 0) {
      status = '🔴';
      totalPendente += parseFloat(conta.valor || 0);
    } else if (diasAteVencer <= 3) {
      status = '🟡';
      totalPendente += parseFloat(conta.valor || 0);
    } else {
      status = '⬜';
      totalPendente += parseFloat(conta.valor || 0);
    }

    const venc = paga ? 'paga' :
      diasAteVencer < 0 ? `venceu ha ${Math.abs(diasAteVencer)}d` :
      diasAteVencer === 0 ? 'vence HOJE' :
      `vence em ${diasAteVencer}d (dia ${conta.dia_vencimento})`;

    texto += `${status} ${conta.descricao} — ${valor}\n`;
    texto += `   ${venc}\n\n`;
  });

  texto += `──────────────\n`;
  texto += `✅ Pago: R$ ${totalPago.toFixed(2)}\n`;
  texto += `⏳ Pendente: R$ ${totalPendente.toFixed(2)}`;

  await ctx.reply(texto, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Marcar como paga', callback_data: 'contas_pagar' }],
        [{ text: '➕ Nova conta', callback_data: 'contas_nova' }],
        [{ text: '⚙️ Gerenciar contas', callback_data: 'contas_gerenciar' }],
      ]
    }
  });
}

// ============================================================
// CALLBACKS
// ============================================================
async function handleCallbackContas(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;

  await ctx.answerCbQuery();

  // ── NOVA CONTA — início do fluxo
  if (data === 'contas_nova') {
    salvarSessao(usuarioId, { etapa: 'aguardando_descricao' });
    await ctx.reply(
      `➕ Nova conta fixa\n\nQual o nome da conta?\nEx: "Luz", "Aluguel", "Internet", "Condominio"`
    );
    return;
  }

  // ── MARCAR COMO PAGA
  if (data === 'contas_pagar') {
    const agora = getDataBrasilia();
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();

    const { data: contas } = await supabase
      .from('contas_fixas')
      .select('*')
      .eq('usuario_id', usuarioId)
      .eq('ativo', true)
      .order('dia_vencimento');

    const { data: pagas } = await supabase
      .from('contas_pagas')
      .select('conta_id')
      .eq('usuario_id', usuarioId)
      .eq('mes', mes)
      .eq('ano', ano);

    const pagasIds = new Set(pagas?.map(p => p.conta_id) || []);
    const pendentes = contas?.filter(c => !pagasIds.has(c.id)) || [];

    if (pendentes.length === 0) {
      await ctx.reply('✅ Todas as contas desse mes ja foram pagas!');
      return;
    }

    const botoes = pendentes.map(c => ([{
      text: `${c.descricao} — ${c.valor ? `R$ ${parseFloat(c.valor).toFixed(2)}` : 'valor variavel'}`,
      callback_data: `contas_conf_pagar_${c.id}`
    }]));
    botoes.push([{ text: '❌ Cancelar', callback_data: 'contas_cancelar' }]);

    await ctx.reply('Qual conta voce pagou?', { reply_markup: { inline_keyboard: botoes } });
    return;
  }

  // ── CONFIRMAR PAGAMENTO
  if (data.startsWith('contas_conf_pagar_')) {
    const contaId = data.replace('contas_conf_pagar_', '');

    const { data: conta } = await supabase
      .from('contas_fixas')
      .select('*, categorias(nome)')
      .eq('id', contaId)
      .single();

    if (!conta) {
      await ctx.reply('Conta nao encontrada!');
      return;
    }

    salvarSessao(usuarioId, { etapa: 'aguardando_valor_pago', contaId, conta });

    const valorSugerido = conta.valor
      ? `\n\nValor sugerido: R$ ${parseFloat(conta.valor).toFixed(2)}\nDigite o valor pago ou confirme:`
      : '\n\nQual foi o valor pago?';

    await ctx.reply(
      `✅ Confirmando pagamento de ${conta.descricao}${valorSugerido}`,
      {
        reply_markup: conta.valor ? {
          inline_keyboard: [[
            { text: `✅ Confirmar R$ ${parseFloat(conta.valor).toFixed(2)}`, callback_data: `contas_pago_valor_${contaId}_${conta.valor}` }
          ], [
            { text: '❌ Cancelar', callback_data: 'contas_cancelar' }
          ]]
        } : {
          inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'contas_cancelar' }]]
        }
      }
    );
    return;
  }

  // ── CONFIRMAR VALOR PADRÃO
  if (data.startsWith('contas_pago_valor_')) {
    const partes = data.replace('contas_pago_valor_', '').split('_');
    const contaId = partes[0];
    const valor = parseFloat(partes[1]);
    await registrarPagamento(ctx, usuarioId, contaId, valor);
    return;
  }

  // ── GERENCIAR CONTAS
  if (data === 'contas_gerenciar') {
    const { data: contas } = await supabase
      .from('contas_fixas')
      .select('*')
      .eq('usuario_id', usuarioId)
      .eq('ativo', true)
      .order('dia_vencimento');

    if (!contas || contas.length === 0) {
      await ctx.reply('Nenhuma conta cadastrada!');
      return;
    }

    const botoes = contas.map(c => ([{
      text: `🗑️ ${c.descricao} (dia ${c.dia_vencimento})`,
      callback_data: `contas_excluir_${c.id}`
    }]));
    botoes.push([{ text: '❌ Fechar', callback_data: 'contas_cancelar' }]);

    await ctx.reply('Selecione a conta para remover:', { reply_markup: { inline_keyboard: botoes } });
    return;
  }

  // ── EXCLUIR CONTA
  if (data.startsWith('contas_excluir_')) {
    const contaId = data.replace('contas_excluir_', '');
    const { data: conta } = await supabase.from('contas_fixas').select('descricao').eq('id', contaId).single();

    await ctx.reply(
      `Remover "${conta?.descricao}"?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗑️ Sim, remover', callback_data: `contas_conf_excluir_${contaId}` },
            { text: '❌ Cancelar', callback_data: 'contas_cancelar' }
          ]]
        }
      }
    );
    return;
  }

  // ── CONFIRMAR EXCLUSÃO
  if (data.startsWith('contas_conf_excluir_')) {
    const contaId = data.replace('contas_conf_excluir_', '');
    await supabase.from('contas_fixas').update({ ativo: false }).eq('id', contaId);
    await ctx.editMessageText('✅ Conta removida!');
    return;
  }

  if (data === 'contas_cancelar') {
    await ctx.editMessageText('🦙 Operacao cancelada!');
    limparSessao(usuarioId);
    return;
  }

  // ── DÉBITO AUTOMÁTICO
  if (data === 'contas_debito_sim' || data === 'contas_debito_nao') {
    const debitoAutomatico = data === 'contas_debito_sim';
    const sessao = buscarSessao(usuarioId);
    if (!sessao) { await ctx.editMessageText('🦙 Sessao expirada. Use /contas para recomecar.'); return; }

    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_categoria', debitoAutomatico });

    const { data: categorias } = await supabase
      .from('categorias')
      .select('id, nome, emoji')
      .eq('padrao', true)
      .eq('ativo', true)
      .order('nome');

    const botoes = [];
    for (let i = 0; i < categorias.length; i += 3) {
      botoes.push(categorias.slice(i, i + 3).map(c => ({
        text: `${c.emoji} ${c.nome}`,
        callback_data: `contas_cat_${c.id}`
      })));
    }

    await ctx.editMessageText('🏷️ Qual a categoria?', { reply_markup: { inline_keyboard: botoes } });
    return;
  }
}

// ============================================================
// REGISTRAR PAGAMENTO
// ============================================================
async function registrarPagamento(ctx, usuarioId, contaId, valorPago) {
  const agora = getDataBrasilia();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

  const { data: conta } = await supabase
    .from('contas_fixas')
    .select('*, categorias(nome)')
    .eq('id', contaId)
    .single();

  try {
    // Registrar na tabela de transacoes
    const { data: transacao } = await supabase
      .from('transacoes')
      .insert({
        usuario_id:    usuarioId,
        categoria_id:  conta.categoria_id,
        descricao:     conta.descricao,
        valor:         valorPago,
        tipo:          'gasto',
        origem:        'conta_fixa',
        data_transacao: agora.toISOString().split('T')[0],
        cancelado:     false,
      })
      .select()
      .single();

    // Marcar como paga no mes
    await supabase.from('contas_pagas').upsert({
      conta_id:    contaId,
      usuario_id:  usuarioId,
      valor_pago:  valorPago,
      mes,
      ano,
      transacao_id: transacao?.id,
      pago_em:     agora.toISOString()
    }, { onConflict: 'conta_id,mes,ano' });

    limparSessao(usuarioId);

    await ctx.reply(
      `✅ ${conta.descricao} paga!\n💰 R$ ${valorPago.toFixed(2)} registrado\n\nUse /contas para ver o status das demais.`
    );
  } catch (err) {
    console.error('Erro ao registrar pagamento:', err);
    await ctx.reply('🦙 Erro ao registrar pagamento. Tenta de novo!');
  }
}

// ============================================================
// HANDLER TEXTO durante cadastro
// ============================================================
async function handleTextoContas(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);
  if (!sessao) return false;

  const texto = ctx.message.text;

  // ── DESCRIÇÃO
  if (sessao.etapa === 'aguardando_descricao') {
    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_dia', descricao: texto });
    await ctx.reply(
      `📅 Qual o dia do vencimento?\nEx: "5", "10", "15"`,
    );
    return true;
  }

  // ── DIA DE VENCIMENTO
  if (sessao.etapa === 'aguardando_dia') {
    const dia = parseInt(texto);
    if (isNaN(dia) || dia < 1 || dia > 31) {
      await ctx.reply('Digite um dia valido entre 1 e 31.');
      return true;
    }
    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_valor', dia });
    await ctx.reply(
      `💰 Qual o valor mensal?\nDigite o valor ou "variavel" se muda todo mes:`,
    );
    return true;
  }

  // ── VALOR
  if (sessao.etapa === 'aguardando_valor') {
    let valor = null;
    if (texto.toLowerCase() !== 'variavel') {
      valor = parseFloat(texto.replace(',', '.'));
      if (isNaN(valor)) {
        await ctx.reply('Digite um valor valido ou "variavel".');
        return true;
      }
    }

    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_debito', valor });

    await ctx.reply(
      `💳 Como essa conta e paga?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔔 Preciso ser avisado', callback_data: 'contas_debito_nao' }],
            [{ text: '⚡ Debito automatico (so registrar)', callback_data: 'contas_debito_sim' }],
          ]
        }
      }
    );
    return true;
  }

    // Buscar categorias
    const { data: categorias } = await supabase
      .from('categorias')
      .select('id, nome, emoji')
      .eq('padrao', true)
      .eq('ativo', true)
      .order('nome');

    const botoes = [];
    for (let i = 0; i < categorias.length; i += 3) {
      botoes.push(categorias.slice(i, i + 3).map(c => ({
        text: `${c.emoji} ${c.nome}`,
        callback_data: `contas_cat_${c.id}`
      })));
    }

    await ctx.reply('🏷️ Qual a categoria?', { reply_markup: { inline_keyboard: botoes } });
    return true;
  }

  // ── VALOR PAGO (valor diferente do padrão)
  if (sessao.etapa === 'aguardando_valor_pago') {
    const valor = parseFloat(texto.replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      await ctx.reply('Digite um valor valido. Ex: 180,50');
      return true;
    }
    await registrarPagamento(ctx, usuarioId, sessao.contaId, valor);
    return true;
  }

  return false;
}

// ============================================================
// CALLBACK de categoria (durante cadastro)
// ============================================================
async function handleCallbackContasCategoria(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  await ctx.answerCbQuery();

  if (!data.startsWith('contas_cat_') || !sessao) return;

  const categoriaId = data.replace('contas_cat_', '');
  const debitoAutomatico = sessao.debitoAutomatico || false;

  // Salvar conta
  const { error } = await supabase.from('contas_fixas').insert({
    usuario_id:       usuarioId,
    descricao:        sessao.descricao,
    valor:            sessao.valor,
    dia_vencimento:   sessao.dia,
    categoria_id:     categoriaId,
    debito_automatico: debitoAutomatico,
    ativo:            true,
  });

  limparSessao(usuarioId);

  if (error) {
    await ctx.editMessageText('🦙 Erro ao salvar conta. Tenta de novo!');
    return;
  }

  const valorTexto = sessao.valor
    ? `R$ ${parseFloat(sessao.valor).toFixed(2)}`
    : 'valor variavel';

  const avisoTexto = debitoAutomatico
    ? `⚡ Debito automatico — vou registrar no dia ${sessao.dia} automaticamente, sem te avisar.`
    : `🔔 Vou te avisar 3 dias antes e no dia do vencimento!`;

  await ctx.editMessageText(
    `✅ Conta cadastrada!\n\n📋 ${sessao.descricao}\n💰 ${valorTexto}\n📅 Vencimento: todo dia ${sessao.dia}\n\n${avisoTexto}\n\nUse /contas para ver todas as suas contas.`
  );
}

module.exports = {
  handleContas,
  handleCallbackContas,
  handleCallbackContasCategoria,
  handleTextoContas,
  registrarPagamento
};
