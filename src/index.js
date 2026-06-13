require('dotenv').config();
const { Telegraf } = require('telegraf');
const { obterOuCriarUsuario } = require('./services/usuarioService');
const { iniciarHealthCheck } = require('./healthcheck');
const { handleFoto, handleVoz, handleDesfazer } = require('./handlers/mensagemHandler');
const {
  handleHoje, handleResumo, handleMes,
  handleParcelas, handleInsights, handlePerguntaLivre
} = require('./handlers/consultaHandler');
const { handleCallbackCartao, handleTextoCartao, iniciarFluxoCartao } = require('./handlers/cartaoHandler');
const { handleDashboard } = require('./handlers/dashboardHandler');
const { handleDefinirMeta, handleVerMetas, handleCallbackMeta, handleTextoMeta } = require('./handlers/metaHandler');
const { handleAgente, handleCallbackAgente, handleTextoAgente } = require('./handlers/agenteCustomHandler');
const { classificarGasto, salvarTransacao, verificarMetas } = require('./services/geminiService');
const { modeloConversa } = require('./config/gemini');
const { iniciarAgentes, executarCuzco, executarLuna, executarInti } = require('./agents/agentes');

iniciarHealthCheck();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    ctx.usuario = await obterOuCriarUsuario(ctx);
  } catch (err) {
    console.error('Erro no middleware de usuário:', err);
  }
  return next();
});

bot.start(async (ctx) => {
  const nome = ctx.from.first_name || 'amigo';
  await ctx.reply(
    `🦙 Ola, ${nome}! Sou o Duartly, sua lhama financeira pessoal.\n\n` +
    `Me conta um gasto e eu ja registro pra voce:\n\n` +
    `Exemplos:\n- "Padaria 18,50"\n- "Nike 350 em 3x"\n- "iFood 45"\n\n` +
    `Ou manda foto do cupom ou audio!\n\nDigite /ajuda para ver tudo! 🦙`
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🦙 O que eu sei fazer:\n\n` +
    `Registrar gastos:\n"Almoco 35", "Uber 22", "Nike 300 em 3x"\n\n` +
    `Consultas:\n/hoje /resumo /mes /parcelas /insights /dashboard\n\n` +
    `Metas:\n/meta - definir meta\n/metas - ver progresso\n\n` +
    `Agentes customizados:\n/agente - criar e gerenciar\n\n` +
    `Agentes autonomos:\n🦙 /cuzco 🌙 /luna ☀️ /inti`
  );
});

bot.command('ping',      (ctx) => ctx.reply('🦙 Duartly online!'));
bot.command('hoje',      handleHoje);
bot.command('resumo',    handleResumo);
bot.command('mes',       handleMes);
bot.command('parcelas',  handleParcelas);
bot.command('insights',  handleInsights);
bot.command('dashboard', handleDashboard);
bot.command('meta',      handleDefinirMeta);
bot.command('metas',     handleVerMetas);
bot.command('agente',    handleAgente);

bot.command('cuzco', async (ctx) => { await ctx.reply('🦙 Chamando o Cuzco...'); await executarCuzco(bot); });
bot.command('luna',  async (ctx) => { await ctx.reply('🌙 Chamando a Luna...'); await executarLuna(bot); });
bot.command('inti',  async (ctx) => { await ctx.reply('☀️ Chamando o Inti...'); await executarInti(bot); });

bot.on('text', async (ctx) => {
  const texto = ctx.message.text;
  const usuarioId = ctx.usuario.id;

  if (await handleTextoMeta(ctx)) return;
  if (await handleTextoAgente(ctx)) return;
  if (await handleTextoCartao(ctx)) return;

  const prompt = `Analise a mensagem e responda APENAS com JSON valido, sem markdown.
Mensagem: "${texto}"
{ "intencao": "gasto" | "consulta" | "conversa" }
- "gasto": menciona valor, compra, pagamento, despesa ou receita
- "consulta": pergunta sobre financas, gastos, historico
- "conversa": qualquer outra coisa`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const json = JSON.parse(resultado.response.text().replace(/```json|```/g, '').trim());

    if (json.intencao === 'gasto') {
      const msg = await ctx.reply('🦙 Analisando...');
      const classificacao = await classificarGasto(texto);

      if (!classificacao || !classificacao.valor) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
          `🦙 Nao consegui identificar um gasto.\n\nTenta: "Padaria 18,50" ou "Uber 22"`);
        return;
      }

      if (classificacao.parcelado && classificacao.total_parcelas > 1) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
        classificacao.raw_input = texto;
        await iniciarFluxoCartao(ctx, classificacao);
        return;
      }

      const resultado2 = await salvarTransacao(usuarioId, classificacao, 'texto', texto);
      const transacao = resultado2.transacoes[0];
      const alertaMeta = await verificarMetas(usuarioId, transacao.categoria_id);

      const emoji = classificacao.tipo === 'receita' ? '💵' : '💸';
      const sinal = classificacao.tipo === 'receita' ? '+' : '-';
      let resposta = `${emoji} ${classificacao.descricao}\n💰 ${sinal}R$ ${classificacao.valor.toFixed(2)}\n🏷️ ${classificacao.categoria}\n✅ Registrado!`;

      if (alertaMeta) {
        resposta += `\n\n⚠️ Voce ja usou ${alertaMeta.percentual}% da meta de ${classificacao.categoria}!`;
      }

      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, resposta, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Desfazer', callback_data: `desfazer_${transacao.id}` }]] }
      });

    } else if (json.intencao === 'consulta') {
      await handlePerguntaLivre(ctx, texto);
    } else {
      await handleConversa(ctx, texto);
    }
  } catch (err) {
    console.error('Erro no roteador:', err);
    await ctx.reply('🦙 Ops! Algo deu errado. Tenta de novo!');
  }
});

async function handleConversa(ctx, texto) {
  const nome = ctx.from.first_name || 'amigo';
  const prompt = `Voce e o Duartly, lhama financeira brasileira bem-humorada.
Responda em NO MAXIMO 2 frases. Sem asteriscos ou markdown.
REGRA: sempre termine redirecionando pro app financeiro.
Mensagem: "${texto}" | Nome: ${nome}`;
  try {
    const resultado = await modeloConversa.generateContent(prompt);
    await ctx.reply(resultado.response.text().trim());
  } catch (err) {
    await ctx.reply('🦙 Haha! Me manda um gasto ou use /hoje!');
  }
}

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith('desfazer_'))  { await handleDesfazer(ctx); return; }
  if (data.startsWith('meta_'))      { await handleCallbackMeta(ctx); return; }
  if (data.startsWith('ac_'))        { await handleCallbackAgente(ctx); return; }
  if (data.startsWith('cartao_') || data.startsWith('venc_') || data.startsWith('parcela_') || data.startsWith('nome_')) {
    await handleCallbackCartao(ctx); return;
  }
});

bot.on('photo', handleFoto);
bot.on('voice', handleVoz);

bot.catch((err, ctx) => {
  console.error('Erro no bot:', err);
  ctx.reply('🦙 Ops! Tenta de novo!').catch(() => {});
});

bot.launch()
  .then(() => {
    console.log('🦙 Duartly v2 rodando!');
    iniciarAgentes(bot);
  })
  .catch((err) => {
    console.error('Erro ao iniciar bot:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
