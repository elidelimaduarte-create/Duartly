// src/agents/agentes.js
// ============================================================
// AGENTES AUTÔNOMOS DO DUARTLY
// Cuzco (diário), Luna (quinzenal), Inti (mensal)
// ============================================================
const cron = require('node-cron');
const supabase = require('../config/supabase');
const { modeloConversa } = require('../config/gemini');

let botInstance = null;

function iniciarAgentes(bot) {
  botInstance = bot;

  // CUZCO — todo dia às 20h (horário de Brasília = 23h UTC)
  cron.schedule('0 23 * * *', () => {
    console.log('🦙 Cuzco acordou! Analisando gastos do dia...');
    executarCuzco();
  }, { timezone: 'America/Sao_Paulo' });

  // LUNA — dias 15 e último dia do mês às 18h
  cron.schedule('0 18 15,28,29,30,31 * *', () => {
    const hoje = new Date();
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    if (hoje.getDate() === 15 || hoje.getDate() === ultimoDia) {
      console.log('🌙 Luna acordou! Analisando tendências quinzenais...');
      executarLuna();
    }
  }, { timezone: 'America/Sao_Paulo' });

  // INTI — todo dia 1 às 9h
  cron.schedule('0 9 1 * *', () => {
    console.log('☀️ Inti acordou! Preparando panorama mensal...');
    executarInti();
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🦙 Agentes Cuzco, Luna e Inti iniciados!');
}

// ============================================================
// BUSCAR TODOS OS USUÁRIOS ATIVOS
// ============================================================
async function buscarUsuariosAtivos() {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('ativo', true);
  return data || [];
}

// ============================================================
// ENVIAR MENSAGEM PARA USUÁRIO
// ============================================================
async function enviarMensagem(telegramId, mensagem) {
  try {
    await botInstance.telegram.sendMessage(telegramId, mensagem);
  } catch (err) {
    console.error(`Erro ao enviar para ${telegramId}:`, err.message);
  }
}

// ============================================================
// CUZCO — Agente Diário
// ============================================================
async function executarCuzco() {
  const usuarios = await buscarUsuariosAtivos();

  for (const usuario of usuarios) {
    try {
      await analisarDiaCuzco(usuario);
    } catch (err) {
      console.error(`Erro Cuzco para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarDiaCuzco(usuario) {
  const hoje = new Date().toISOString().split('T')[0];

  // Buscar gastos do dia
  const { data: gastosHoje } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuario.id)
    .eq('data_transacao', hoje)
    .eq('tipo', 'gasto')
    .eq('cancelado', false);

  if (!gastosHoje || gastosHoje.length === 0) return; // Sem gastos hoje, não incomoda

  const totalHoje = gastosHoje.reduce((a, t) => a + parseFloat(t.valor), 0);

  // Buscar média dos últimos 30 dias para comparar
  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

  const { data: gastosRecentes } = await supabase
    .from('transacoes')
    .select('valor, data_transacao')
    .eq('usuario_id', usuario.id)
    .eq('tipo', 'gasto')
    .eq('cancelado', false)
    .gte('data_transacao', trintaDiasAtras.toISOString().split('T')[0])
    .lt('data_transacao', hoje);

  // Calcular média diária
  const diasComGasto = new Set(gastosRecentes?.map(t => t.data_transacao) || []).size;
  const totalRecente = gastosRecentes?.reduce((a, t) => a + parseFloat(t.valor), 0) || 0;
  const mediaDiaria = diasComGasto > 0 ? totalRecente / diasComGasto : 0;

  // Montar resumo para o Gemini
  const resumoGastos = gastosHoje.map(t =>
    `${t.categorias?.emoji || '📌'} ${t.descricao}: R$ ${t.valor} (${t.categorias?.nome || 'Outros'})`
  ).join('\n');

  const acimaDaMedia = mediaDiaria > 0 && totalHoje > mediaDiaria * 1.5;

  const prompt = `
Voce e o Cuzco, agente financeiro diario do Duartly. Personalidade: esperto, direto, um pouco ironico mas simpatico.
Analise os gastos de hoje do usuario ${usuario.nome || 'usuario'} e mande uma mensagem curta (max 3 frases).
Sem markdown, sem asteriscos.

Gastos de hoje:
${resumoGastos}

Total hoje: R$ ${totalHoje.toFixed(2)}
Media diaria dos ultimos 30 dias: R$ ${mediaDiaria.toFixed(2)}
Acima da media: ${acimaDaMedia ? 'SIM - 50% acima!' : 'nao'}

${acimaDaMedia ? 'DESTAQUE que hoje foi um dia de gastos acima do normal.' : 'Faca um resumo rapido e simpatico.'}

Comece com: "🦙 Cuzco aqui!"
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();

  await enviarMensagem(usuario.telegram_id, mensagem);

  // Registrar no job
  await supabase.from('jobs_agendados')
    .update({ ultimo_envio: new Date().toISOString() })
    .eq('usuario_id', usuario.id)
    .eq('tipo', 'relatorio_semanal');
}

// ============================================================
// LUNA — Agente Quinzenal
// ============================================================
async function executarLuna() {
  const usuarios = await buscarUsuariosAtivos();

  for (const usuario of usuarios) {
    try {
      await analisarQuinzenaLuna(usuario);
    } catch (err) {
      console.error(`Erro Luna para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarQuinzenaLuna(usuario) {
  const hoje = new Date();
  const quinzeDiasAtras = new Date();
  quinzeDiasAtras.setDate(hoje.getDate() - 15);

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuario.id)
    .eq('cancelado', false)
    .eq('tipo', 'gasto')
    .gte('data_transacao', quinzeDiasAtras.toISOString().split('T')[0])
    .lte('data_transacao', hoje.toISOString().split('T')[0]);

  if (!transacoes || transacoes.length < 3) return;

  // Agrupar por categoria
  const porCategoria = {};
  transacoes.forEach(t => {
    const cat = t.categorias?.nome || 'Outros';
    if (!porCategoria[cat]) porCategoria[cat] = 0;
    porCategoria[cat] += parseFloat(t.valor);
  });

  const resumo = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, total]) => `${cat}: R$ ${total.toFixed(2)}`)
    .join('\n');

  const totalGasto = transacoes.reduce((a, t) => a + parseFloat(t.valor), 0);

  const prompt = `
Voce e a Luna, agente financeira quinzenal do Duartly. Personalidade: analitica, serena, perspicaz.
Analise os gastos dos ultimos 15 dias e identifique 2-3 tendencias importantes.
Sem markdown, sem asteriscos. Maximo 4 frases.

Usuario: ${usuario.nome || 'usuario'}
Total gasto: R$ ${totalGasto.toFixed(2)}
Por categoria:
${resumo}

Comece com: "🌙 Luna aqui!"
Termine sugerindo uma acao pratica para os proximos 15 dias.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();

  await enviarMensagem(usuario.telegram_id, mensagem);

  await supabase.from('jobs_agendados')
    .update({ ultimo_envio: new Date().toISOString() })
    .eq('usuario_id', usuario.id)
    .eq('tipo', 'relatorio_semanal');
}

// ============================================================
// INTI — Agente Mensal
// ============================================================
async function executarInti() {
  const usuarios = await buscarUsuariosAtivos();

  for (const usuario of usuarios) {
    try {
      await analisarMesInti(usuario);
    } catch (err) {
      console.error(`Erro Inti para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarMesInti(usuario) {
  // Pegar mês anterior
  const agora = new Date();
  const mesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const inicioMes = mesAnterior.toISOString().split('T')[0];
  const fimMes = new Date(agora.getFullYear(), agora.getMonth(), 0).toISOString().split('T')[0];

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuario.id)
    .eq('cancelado', false)
    .gte('data_transacao', inicioMes)
    .lte('data_transacao', fimMes);

  if (!transacoes || transacoes.length < 3) return;

  const gastos = transacoes.filter(t => t.tipo === 'gasto');
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const totalGastos = gastos.reduce((a, t) => a + parseFloat(t.valor), 0);
  const totalReceitas = receitas.reduce((a, t) => a + parseFloat(t.valor), 0);
  const saldo = totalReceitas - totalGastos;

  // Top categorias
  const porCategoria = {};
  gastos.forEach(t => {
    const cat = t.categorias?.nome || 'Outros';
    if (!porCategoria[cat]) porCategoria[cat] = 0;
    porCategoria[cat] += parseFloat(t.valor);
  });

  const topCategorias = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, total]) => `${cat}: R$ ${total.toFixed(2)}`)
    .join(', ');

  const nomeMes = mesAnterior.toLocaleString('pt-BR', { month: 'long' });

  const prompt = `
Voce e o Inti, agente financeiro mensal do Duartly. Personalidade: grandioso, visionario, estrategico.
Faca um panorama do mes de ${nomeMes} e uma projecao estrategica para o mes atual.
Sem markdown, sem asteriscos. Maximo 5 frases.

Usuario: ${usuario.nome || 'usuario'}
Receitas: R$ ${totalReceitas.toFixed(2)}
Gastos: R$ ${totalGastos.toFixed(2)}
Saldo: R$ ${saldo.toFixed(2)}
Top categorias: ${topCategorias}

Comece com: "☀️ Inti aqui! Fechamento de ${nomeMes}:"
Termine com uma estrategia clara para o mes atual.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();

  await enviarMensagem(usuario.telegram_id, mensagem);

  await supabase.from('jobs_agendados')
    .update({ ultimo_envio: new Date().toISOString() })
    .eq('usuario_id', usuario.id)
    .eq('tipo', 'relatorio_mensal');
}

// ============================================================
// EXPORTAR PARA TESTES MANUAIS
// ============================================================
module.exports = {
  iniciarAgentes,
  executarCuzco,
  executarLuna,
  executarInti
};
