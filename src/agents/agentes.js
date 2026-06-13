// src/agents/agentes.js
const cron = require('node-cron');
const supabase = require('../config/supabase');
const { modeloConversa } = require('../config/gemini');

// ============================================================
// BUSCAR USUÁRIOS ATIVOS
// ============================================================
async function buscarUsuariosAtivos() {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('ativo', true);
  return data || [];
}

// ============================================================
// ENVIAR MENSAGEM
// ============================================================
async function enviarMensagem(bot, telegramId, mensagem) {
  try {
    await bot.telegram.sendMessage(telegramId, mensagem);
  } catch (err) {
    console.error(`Erro ao enviar para ${telegramId}:`, err.message);
  }
}

// ============================================================
// CUZCO — Agente Diário
// ============================================================
async function executarCuzco(bot) {
  const usuarios = await buscarUsuariosAtivos();
  for (const usuario of usuarios) {
    try {
      await analisarDiaCuzco(bot, usuario);
    } catch (err) {
      console.error(`Erro Cuzco para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarDiaCuzco(bot, usuario) {
  const hoje = new Date().toISOString().split('T')[0];

  const { data: gastosHoje } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuario.id)
    .eq('data_transacao', hoje)
    .eq('tipo', 'gasto')
    .eq('cancelado', false);

  if (!gastosHoje || gastosHoje.length === 0) {
    await enviarMensagem(bot, usuario.telegram_id,
      `🦙 Cuzco aqui! Nenhum gasto registrado hoje. Dia economico ou esqueceu de registrar? Me manda seus gastos!`
    );
    return;
  }

  const totalHoje = gastosHoje.reduce((a, t) => a + parseFloat(t.valor), 0);

  // Média dos últimos 30 dias
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

  const diasComGasto = new Set(gastosRecentes?.map(t => t.data_transacao) || []).size;
  const totalRecente = gastosRecentes?.reduce((a, t) => a + parseFloat(t.valor), 0) || 0;
  const mediaDiaria = diasComGasto > 0 ? totalRecente / diasComGasto : 0;
  const acimaDaMedia = mediaDiaria > 0 && totalHoje > mediaDiaria * 1.5;

  const resumoGastos = gastosHoje.map(t =>
    `${t.categorias?.emoji || '📌'} ${t.descricao}: R$ ${t.valor} (${t.categorias?.nome || 'Outros'})`
  ).join('\n');

  const prompt = `
Voce e o Cuzco, agente financeiro diario do Duartly. Personalidade: esperto, direto, ironico mas simpatico.
Analise os gastos de hoje e mande mensagem curta (max 3 frases). Sem markdown, sem asteriscos.

Usuario: ${usuario.nome || 'usuario'}
Gastos de hoje:
${resumoGastos}
Total hoje: R$ ${totalHoje.toFixed(2)}
Media diaria 30 dias: R$ ${mediaDiaria.toFixed(2)}
Acima da media: ${acimaDaMedia ? 'SIM - 50% acima!' : 'nao'}

${acimaDaMedia ? 'ALERTE que hoje foi dia de gastos acima do normal!' : 'Faca resumo rapido e simpatico.'}
Comece com: "🦙 Cuzco aqui!"
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();
  await enviarMensagem(bot, usuario.telegram_id, mensagem);
}

// ============================================================
// LUNA — Agente Quinzenal
// ============================================================
async function executarLuna(bot) {
  const usuarios = await buscarUsuariosAtivos();
  for (const usuario of usuarios) {
    try {
      await analisarQuinzenaLuna(bot, usuario);
    } catch (err) {
      console.error(`Erro Luna para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarQuinzenaLuna(bot, usuario) {
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

  if (!transacoes || transacoes.length < 2) {
    await enviarMensagem(bot, usuario.telegram_id,
      `🌙 Luna aqui! Ainda tenho poucos dados para analisar os ultimos 15 dias. Continue registrando seus gastos!`
    );
    return;
  }

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
Analise os gastos dos ultimos 15 dias e identifique 2-3 tendencias. Sem markdown. Maximo 4 frases.

Usuario: ${usuario.nome || 'usuario'}
Total gasto: R$ ${totalGasto.toFixed(2)}
Por categoria:
${resumo}

Comece com: "🌙 Luna aqui!"
Termine sugerindo uma acao pratica para os proximos 15 dias.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();
  await enviarMensagem(bot, usuario.telegram_id, mensagem);
}

// ============================================================
// INTI — Agente Mensal
// ============================================================
async function executarInti(bot) {
  const usuarios = await buscarUsuariosAtivos();
  for (const usuario of usuarios) {
    try {
      await analisarMesInti(bot, usuario);
    } catch (err) {
      console.error(`Erro Inti para ${usuario.telegram_id}:`, err);
    }
  }
}

async function analisarMesInti(bot, usuario) {
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

  if (!transacoes || transacoes.length < 2) {
    await enviarMensagem(bot, usuario.telegram_id,
      `☀️ Inti aqui! Dados insuficientes do mes anterior para gerar projecao. Continue registrando seus gastos!`
    );
    return;
  }

  const gastos = transacoes.filter(t => t.tipo === 'gasto');
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const totalGastos = gastos.reduce((a, t) => a + parseFloat(t.valor), 0);
  const totalReceitas = receitas.reduce((a, t) => a + parseFloat(t.valor), 0);
  const saldo = totalReceitas - totalGastos;

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
Faca panorama do mes de ${nomeMes} e projecao para o mes atual. Sem markdown. Maximo 5 frases.

Usuario: ${usuario.nome || 'usuario'}
Receitas: R$ ${totalReceitas.toFixed(2)}
Gastos: R$ ${totalGastos.toFixed(2)}
Saldo: R$ ${saldo.toFixed(2)}
Top categorias: ${topCategorias}

Comece com: "☀️ Inti aqui! Fechamento de ${nomeMes}:"
Termine com estrategia clara para o mes atual.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  const mensagem = resultado.response.text().trim();
  await enviarMensagem(bot, usuario.telegram_id, mensagem);
}

// ============================================================
// INICIAR CRON JOBS
// ============================================================
function iniciarAgentes(bot) {
  // Cuzco — todo dia às 20h
  cron.schedule('0 20 * * *', () => {
    console.log('🦙 Cuzco iniciando analise diaria...');
    executarCuzco(bot);
  }, { timezone: 'America/Sao_Paulo' });

  // Luna — dias 15 e último do mês às 18h
  cron.schedule('0 18 15,28,29,30,31 * *', () => {
    const hoje = new Date();
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    if (hoje.getDate() === 15 || hoje.getDate() === ultimoDia) {
      console.log('🌙 Luna iniciando analise quinzenal...');
      executarLuna(bot);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Inti — todo dia 1 às 9h
  cron.schedule('0 9 1 * *', () => {
    console.log('☀️ Inti iniciando panorama mensal...');
    executarInti(bot);
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🦙 Agentes Cuzco, Luna e Inti iniciados!');
}

module.exports = {
  iniciarAgentes,
  executarCuzco,
  executarLuna,
  executarInti
};
