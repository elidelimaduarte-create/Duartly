// src/handlers/consultaHandler.js
const supabase = require('../config/supabase');
const { modeloConversa } = require('../config/gemini');

// ============================================================
// /hoje — gastos do dia
// ============================================================
async function handleHoje(ctx) {
  const usuarioId = ctx.usuario.id;
  const hoje = new Date().toISOString().split('T')[0];

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('data_transacao', hoje)
    .eq('cancelado', false)
    .order('criado_em', { ascending: false });

  if (!transacoes || transacoes.length === 0) {
    await ctx.reply('🦙 Nenhum gasto registrado hoje ainda!');
    return;
  }

  const gastos = transacoes.filter(t => t.tipo === 'gasto');
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const totalGastos = gastos.reduce((acc, t) => acc + parseFloat(t.valor), 0);
  const totalReceitas = receitas.reduce((acc, t) => acc + parseFloat(t.valor), 0);

  let resposta = `🦙 *Hoje — ${formatarData(hoje)}*\n\n`;

  if (gastos.length > 0) {
    resposta += `*💸 Gastos:*\n`;
    gastos.forEach(t => {
      const emoji = t.categorias?.emoji || '📌';
      resposta += `${emoji} ${t.descricao} — R$ ${parseFloat(t.valor).toFixed(2)}\n`;
    });
    resposta += `\n💰 *Total gasto: R$ ${totalGastos.toFixed(2)}*`;
  }

  if (receitas.length > 0) {
    resposta += `\n\n*💵 Receitas:*\n`;
    receitas.forEach(t => {
      resposta += `💵 ${t.descricao} — R$ ${parseFloat(t.valor).toFixed(2)}\n`;
    });
    resposta += `\n💰 *Total recebido: R$ ${totalReceitas.toFixed(2)}*`;
  }

  await ctx.reply(resposta, { parse_mode: 'Markdown' });
}

// ============================================================
// /resumo — semana atual
// ============================================================
async function handleResumo(ctx) {
  const usuarioId = ctx.usuario.id;
  const { inicio, fim } = getSemanaAtual();

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .eq('tipo', 'gasto')
    .gte('data_transacao', inicio)
    .lte('data_transacao', fim)
    .order('data_transacao', { ascending: false });

  if (!transacoes || transacoes.length === 0) {
    await ctx.reply('🦙 Nenhum gasto essa semana ainda!');
    return;
  }

  // Agrupar por categoria
  const porCategoria = {};
  transacoes.forEach(t => {
    const cat = t.categorias?.nome || 'Outros';
    const emoji = t.categorias?.emoji || '📌';
    if (!porCategoria[cat]) porCategoria[cat] = { total: 0, emoji, qtd: 0 };
    porCategoria[cat].total += parseFloat(t.valor);
    porCategoria[cat].qtd++;
  });

  const totalGeral = transacoes.reduce((acc, t) => acc + parseFloat(t.valor), 0);

  let resposta = `🦙 *Resumo da Semana*\n`;
  resposta += `_${formatarData(inicio)} a ${formatarData(fim)}_\n\n`;

  // Ordenar por maior gasto
  Object.entries(porCategoria)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([cat, dados]) => {
      const barra = gerarBarra(dados.total, totalGeral);
      resposta += `${dados.emoji} *${cat}*\n`;
      resposta += `${barra} R$ ${dados.total.toFixed(2)}\n\n`;
    });

  resposta += `💰 *Total: R$ ${totalGeral.toFixed(2)}*\n`;
  resposta += `📊 ${transacoes.length} lançamentos`;

  await ctx.reply(resposta, { parse_mode: 'Markdown' });
}

// ============================================================
// /mes — fechamento do mês
// ============================================================
async function handleMes(ctx) {
  const usuarioId = ctx.usuario.id;
  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();
  const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimMes = new Date(ano, mes, 0).toISOString().split('T')[0];

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .gte('data_transacao', inicioMes)
    .lte('data_transacao', fimMes)
    .order('criado_em', { ascending: false });

  if (!transacoes || transacoes.length === 0) {
    await ctx.reply('🦙 Nenhum lançamento esse mês ainda!');
    return;
  }

  const gastos = transacoes.filter(t => t.tipo === 'gasto');
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const totalGastos = gastos.reduce((acc, t) => acc + parseFloat(t.valor), 0);
  const totalReceitas = receitas.reduce((acc, t) => acc + parseFloat(t.valor), 0);
  const saldo = totalReceitas - totalGastos;

  // Agrupar gastos por categoria
  const porCategoria = {};
  gastos.forEach(t => {
    const cat = t.categorias?.nome || 'Outros';
    const emoji = t.categorias?.emoji || '📌';
    if (!porCategoria[cat]) porCategoria[cat] = { total: 0, emoji };
    porCategoria[cat].total += parseFloat(t.valor);
  });

  const nomeMes = agora.toLocaleString('pt-BR', { month: 'long' });
  let resposta = `🦙 *${nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1)} ${ano}*\n\n`;

  resposta += `💵 *Receitas:* R$ ${totalReceitas.toFixed(2)}\n`;
  resposta += `💸 *Gastos:* R$ ${totalGastos.toFixed(2)}\n`;
  resposta += `${saldo >= 0 ? '✅' : '⚠️'} *Saldo: R$ ${saldo.toFixed(2)}*\n\n`;

  resposta += `*Por categoria:*\n`;
  Object.entries(porCategoria)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([cat, dados]) => {
      const barra = gerarBarra(dados.total, totalGastos);
      resposta += `${dados.emoji} ${cat}: R$ ${dados.total.toFixed(2)} ${barra}\n`;
    });

  await ctx.reply(resposta, { parse_mode: 'Markdown' });
}

// ============================================================
// /parcelas — parcelamentos ativos
// ============================================================
async function handleParcelas(ctx) {
  const usuarioId = ctx.usuario.id;
  const hoje = new Date().toISOString().split('T')[0];

  const { data: parcelas } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .eq('parcelado', true)
    .gte('data_transacao', hoje)
    .order('data_transacao', { ascending: true });

  if (!parcelas || parcelas.length === 0) {
    await ctx.reply('🦙 Nenhum parcelamento ativo!');
    return;
  }

  // Agrupar por grupo_parcela
  const grupos = {};
  parcelas.forEach(p => {
    const grupo = p.grupo_parcela;
    if (!grupos[grupo]) grupos[grupo] = [];
    grupos[grupo].push(p);
  });

  let resposta = `💳 *Parcelamentos Ativos*\n\n`;
  let totalMensal = 0;

  Object.values(grupos).forEach(grupo => {
    const primeira = grupo[0];
    const valorParcela = parseFloat(primeira.valor);
    const restantes = grupo.length;
    const totalRestante = valorParcela * restantes;
    totalMensal += valorParcela;

    // Pegar nome sem "(X/Y)"
    const nome = primeira.descricao.replace(/\s*\(\d+\/\d+\)/, '');
    resposta += `📦 *${nome}*\n`;
    resposta += `💰 R$ ${valorParcela.toFixed(2)}/mês × ${restantes} restantes\n`;
    resposta += `📅 Próxima: ${formatarData(primeira.data_transacao)}\n`;
    resposta += `💸 Total restante: R$ ${totalRestante.toFixed(2)}\n\n`;
  });

  resposta += `💳 *Compromisso mensal: R$ ${totalMensal.toFixed(2)}*`;

  await ctx.reply(resposta, { parse_mode: 'Markdown' });
}

// ============================================================
// /insights — análise de padrões (Cuzco fala!)
// ============================================================
async function handleInsights(ctx) {
  const usuarioId = ctx.usuario.id;
  const msg = await ctx.reply('🦙 Cuzco analisando seus padrões...');

  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .eq('tipo', 'gasto')
    .gte('data_transacao', trintaDiasAtras.toISOString().split('T')[0])
    .order('data_transacao', { ascending: true });

  if (!transacoes || transacoes.length < 3) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ainda tenho poucos dados para analisar. Registra mais alguns gastos!'
    );
    return;
  }

  // Montar resumo para o Gemini
  const resumo = transacoes.map(t =>
    `${t.data_transacao}: ${t.descricao} - R$ ${t.valor} (${t.categorias?.nome || 'Outros'})`
  ).join('\n');

  const prompt = `
Você é o Cuzco, agente financeiro esperto e direto da lhama Duartly.
Analise esses gastos dos últimos 30 dias e dê 3-4 insights práticos em português brasileiro.
Seja direto, use emojis, máximo 200 palavras.

Gastos:
${resumo}

Formato da resposta:
🦙 *Cuzco aqui! Analisei seus últimos 30 dias:*

[insights diretos e práticos]

*💡 Dica principal:* [uma ação concreta]
`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const insights = resultado.response.text();

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      insights,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Erro nos insights:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Cuzco está descansando! Tenta de novo em instantes.'
    );
  }
}

// ============================================================
// PERGUNTAS LIVRES em linguagem natural
// ============================================================
async function handlePerguntaLivre(ctx, pergunta) {
  const usuarioId = ctx.usuario.id;
  const msg = await ctx.reply('🦙 Consultando...', { parse_mode: 'Markdown' });

  // Buscar últimas transações para contexto
  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuarioId)
    .eq('cancelado', false)
    .order('data_transacao', { ascending: false })
    .limit(100);

  if (!transacoes || transacoes.length === 0) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ainda não tenho transações suas para consultar!'
    );
    return;
  }

  const resumo = transacoes.map(t =>
    `${t.data_transacao}: ${t.descricao} - R$ ${t.valor} (${t.tipo}, ${t.categorias?.nome || 'Outros'})`
  ).join('\n');

  const hoje = new Date().toISOString().split('T')[0];

  const prompt = `
Você é o Duartly, assistente financeiro pessoal simpático e direto.
Hoje é ${hoje}. Responda a pergunta do usuário com base nas transações abaixo.
Use emojis, seja conciso, máximo 150 palavras, em português brasileiro.

Pergunta: "${pergunta}"

Transações:
${resumo}
`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const resposta = resultado.response.text();

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      resposta,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Erro na pergunta livre:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ops! Não consegui responder. Tenta de novo!'
    );
  }
}

// ============================================================
// HELPERS
// ============================================================
function formatarData(dataStr) {
  const [ano, mes, dia] = dataStr.split('-');
  return `${dia}/${mes}/${ano}`;
}

function getSemanaAtual() {
  const hoje = new Date();
  const diaSemana = hoje.getDay();
  const inicio = new Date(hoje);
  inicio.setDate(hoje.getDate() - diaSemana);
  const fim = new Date(inicio);
  fim.setDate(inicio.getDate() + 6);
  return {
    inicio: inicio.toISOString().split('T')[0],
    fim: fim.toISOString().split('T')[0]
  };
}

function gerarBarra(valor, total) {
  const percentual = Math.round((valor / total) * 10);
  return '█'.repeat(percentual) + '░'.repeat(10 - percentual);
}

module.exports = {
  handleHoje,
  handleResumo,
  handleMes,
  handleParcelas,
  handleInsights,
  handlePerguntaLivre
};
