// src/agents/agentes.js
const cron = require('node-cron');
const supabase = require('../config/supabase');
const { modeloConversa } = require('../config/gemini');

// ============================================================
// HELPERS
// ============================================================
async function buscarUsuariosAtivos() {
  const { data } = await supabase.from('usuarios').select('*').eq('ativo', true);
  return data || [];
}

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
    try { await analisarDiaCuzco(bot, usuario); }
    catch (err) { console.error(`Erro Cuzco para ${usuario.telegram_id}:`, err); }
  }
}

async function analisarDiaCuzco(bot, usuario) {
  const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { data: gastosHoje } = await supabase
    .from('transacoes')
    .select('*, categorias(nome, emoji)')
    .eq('usuario_id', usuario.id)
    .eq('data_transacao', hoje)
    .eq('tipo', 'gasto')
    .eq('cancelado', false);

  if (!gastosHoje || gastosHoje.length === 0) {
    await enviarMensagem(bot, usuario.telegram_id,
      `🦙 Cuzco aqui! Nenhum gasto registrado hoje. Dia economico ou esqueceu de anotar? Me manda seus gastos!`
    );
    return;
  }

  const totalHoje = gastosHoje.reduce((a, t) => a + parseFloat(t.valor), 0);

  const trintaDiasAtras = new Date(Date.now() - 3 * 60 * 60 * 1000);
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
Voce e o Cuzco, agente financeiro diario do Duartly. Esperto, direto, ironico mas simpatico.
Analise os gastos de hoje e mande mensagem curta (max 3 frases). Sem markdown.
Usuario: ${usuario.nome || 'usuario'}
Gastos: ${resumoGastos}
Total hoje: R$ ${totalHoje.toFixed(2)}
Media 30 dias: R$ ${mediaDiaria.toFixed(2)}
Acima da media: ${acimaDaMedia ? 'SIM!' : 'nao'}
${acimaDaMedia ? 'ALERTE sobre gastos acima do normal!' : 'Faca resumo simpatico.'}
Comece com: "🦙 Cuzco aqui!"
`;

  const resultado = await modeloConversa.generateContent(prompt);
  await enviarMensagem(bot, usuario.telegram_id, resultado.response.text().trim());
}

// ============================================================
// LUNA — Agente Quinzenal
// ============================================================
async function executarLuna(bot) {
  const usuarios = await buscarUsuariosAtivos();
  for (const usuario of usuarios) {
    try { await analisarQuinzenaLuna(bot, usuario); }
    catch (err) { console.error(`Erro Luna para ${usuario.telegram_id}:`, err); }
  }
}

async function analisarQuinzenaLuna(bot, usuario) {
  const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const quinzeDiasAtras = new Date(hoje);
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
      `🌙 Luna aqui! Poucos dados nos ultimos 15 dias. Continue registrando seus gastos!`
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
    .map(([cat, total]) => `${cat}: R$ ${total.toFixed(2)}`).join('\n');

  const totalGasto = transacoes.reduce((a, t) => a + parseFloat(t.valor), 0);

  const prompt = `
Voce e a Luna, agente financeira quinzenal do Duartly. Analitica, serena, perspicaz.
Analise 15 dias e identifique 2-3 tendencias. Sem markdown. Max 4 frases.
Usuario: ${usuario.nome || 'usuario'}
Total: R$ ${totalGasto.toFixed(2)}
Por categoria: ${resumo}
Comece com: "🌙 Luna aqui!"
Termine sugerindo uma acao pratica.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  await enviarMensagem(bot, usuario.telegram_id, resultado.response.text().trim());
}

// ============================================================
// INTI — Agente Mensal
// ============================================================
async function executarInti(bot) {
  const usuarios = await buscarUsuariosAtivos();
  for (const usuario of usuarios) {
    try { await analisarMesInti(bot, usuario); }
    catch (err) { console.error(`Erro Inti para ${usuario.telegram_id}:`, err); }
  }
}

async function analisarMesInti(bot, usuario) {
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
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
      `☀️ Inti aqui! Dados insuficientes do mes anterior. Continue registrando!`
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
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([cat, total]) => `${cat}: R$ ${total.toFixed(2)}`).join(', ');

  const nomeMes = mesAnterior.toLocaleString('pt-BR', { month: 'long' });

  const prompt = `
Voce e o Inti, agente financeiro mensal do Duartly. Grandioso, visionario, estrategico.
Panorama de ${nomeMes} e projecao para o mes atual. Sem markdown. Max 5 frases.
Usuario: ${usuario.nome || 'usuario'}
Receitas: R$ ${totalReceitas.toFixed(2)} | Gastos: R$ ${totalGastos.toFixed(2)} | Saldo: R$ ${saldo.toFixed(2)}
Top: ${topCategorias}
Comece com: "☀️ Inti aqui! Fechamento de ${nomeMes}:"
Termine com estrategia para o mes atual.
`;

  const resultado = await modeloConversa.generateContent(prompt);
  await enviarMensagem(bot, usuario.telegram_id, resultado.response.text().trim());
}

// ============================================================
// AGENTES CUSTOMIZADOS
// ============================================================
async function executarAgentesCustomizados(bot) {
  const agoraBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const horaAtual = agoraBrasilia.getHours();
  const diaAtual = agoraBrasilia.getDay();
  const diaDoMes = agoraBrasilia.getDate();
  const hoje = agoraBrasilia.toISOString().split('T')[0];
  const mes = agoraBrasilia.getMonth() + 1;
  const ano = agoraBrasilia.getFullYear();

  const { data: agentes } = await supabase
    .from('agentes_customizados')
    .select('*, usuarios(telegram_id, nome)')
    .eq('ativo', true);

  if (!agentes || agentes.length === 0) return;

  for (const agente of agentes) {
    try {
      const config = agente.config;
      const telegramId = agente.usuarios?.telegram_id;
      if (!telegramId) continue;

      if (agente.tipo === 'relatorio_agendado' && config.hora === horaAtual) {
        const deveDisparar =
          config.frequencia === 'diario' ||
          (config.frequencia === 'semanal' && diaAtual === 1) ||
          (config.frequencia === 'mensal' && diaDoMes === 1);

        if (deveDisparar) {
          const { data: transacoes } = await supabase
            .from('transacoes').select('valor')
            .eq('usuario_id', agente.usuario_id).eq('cancelado', false).eq('tipo', 'gasto')
            .gte('data_transacao', `${ano}-${String(mes).padStart(2,'0')}-01`)
            .lte('data_transacao', hoje);

          const total = transacoes?.reduce((a, t) => a + parseFloat(t.valor), 0) || 0;

          const prompt = `Voce e o Duartly. Relatorio rapido e simpatico. Sem markdown. Max 3 frases.
Usuario: ${agente.usuarios?.nome || 'usuario'} | Total mes: R$ ${total.toFixed(2)} | Lancamentos: ${transacoes?.length || 0}
Comece com: "📊 Relatorio Duartly!"`;

          const resultado = await modeloConversa.generateContent(prompt);
          await enviarMensagem(bot, telegramId, resultado.response.text().trim());
          await supabase.from('agentes_customizados').update({ ultimo_disparo: new Date().toISOString() }).eq('id', agente.id);
        }
      }

      if (agente.tipo === 'lembrete_registro' && config.hora === horaAtual) {
        const { data: gastosHoje } = await supabase
          .from('transacoes').select('id')
          .eq('usuario_id', agente.usuario_id).eq('data_transacao', hoje).eq('cancelado', false);

        if (!gastosHoje || gastosHoje.length === 0) {
          await enviarMensagem(bot, telegramId,
            `⏰ Oi! Voce ainda nao registrou nenhum gasto hoje. Esqueceu de anotar? Me manda seus gastos! 🦙`
          );
        }
        await supabase.from('agentes_customizados').update({ ultimo_disparo: new Date().toISOString() }).eq('id', agente.id);
      }

    } catch (err) {
      console.error(`Erro agente customizado ${agente.id}:`, err);
    }
  }
}

// ============================================================
// INICIAR CRON JOBS
// ============================================================
function iniciarAgentes(bot) {
  // Cuzco — todo dia às 20h
  cron.schedule('0 20 * * *', () => {
    console.log('🦙 Cuzco iniciando...');
    executarCuzco(bot);
  }, { timezone: 'America/Sao_Paulo' });

  // Luna — dias 15 e último do mês às 18h
  cron.schedule('0 18 15,28,29,30,31 * *', () => {
    const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    if (hoje.getDate() === 15 || hoje.getDate() === ultimoDia) {
      console.log('🌙 Luna iniciando...');
      executarLuna(bot);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Inti — todo dia 1 às 9h
  cron.schedule('0 9 1 * *', () => {
    console.log('☀️ Inti iniciando...');
    executarInti(bot);
  }, { timezone: 'America/Sao_Paulo' });

  // Agentes customizados — toda hora cheia
  cron.schedule('0 * * * *', () => {
    console.log('🤖 Verificando agentes customizados...');
    executarAgentesCustomizados(bot);
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🦙 Agentes Cuzco, Luna, Inti e customizados iniciados!');
}

module.exports = {
  iniciarAgentes,
  executarCuzco,
  executarLuna,
  executarInti,
  executarAgentesCustomizados
};
