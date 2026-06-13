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
const { classificarGasto, salvarTransacao, verificarMetas } = require('./services/geminiService');
const { modeloConversa } = require('./config/gemini');

iniciarHealthCheck();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware: registra usuário
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    ctx.usuario = await obterOuCriarUsuario(ctx);
  } catch (err) {
    console.error('Erro no middleware de usuário:', err);
  }
  return next();
});

// /start
bot.start(async (ctx) => {
  const nome = ctx.from.first_name || 'amigo';
  await ctx.reply(
    `🦙 Ola, ${nome}! Sou o Duartly, sua lhama financeira pessoal.\n\n` +
    `Me conta um gasto e eu ja registro pra voce:\n\n` +
    `Exemplos:\n` +
    `- "Padaria 18,50"\n` +
    `- "Nike 350 em 3x no credito"\n` +
    `- "iFood 45"\n\n` +
    `Ou manda uma foto do cupom ou audio!\n\n` +
    `Digite /ajuda para ver tudo que sei fazer! 🦙`
  );
});

// /ajuda
bot.help(async (ctx) => {
  await ctx.reply(
    `🦙 O que eu sei fazer:\n\n` +
    `Registrar gastos - so falar natural:\n` +
    `"Almoco 35", "Uber 22", "Nike 300 em 3x"\n\n` +
    `Ou manda:\n` +
    `Foto do cupom -> leio e registro\n` +
    `Audio -> transcrevo e registro\n\n` +
    `Consultas:\n` +
    `/hoje - gastos do dia\n` +
    `/resumo - semana atual\n` +
    `/mes - fechamento do mes\n` +
    `/parcelas - parcelamentos ativos\n` +
    `/insights - Cuzco analisa seus padroes\n` +
    `/dashboard - seu painel financeiro completo\n\n` +
    `Perguntas naturais:\n` +
    `"Quanto gastei com delivery esse mes?"\n` +
    `"Qual foi meu maior gasto essa semana?"`
  );
});

// Comandos
bot.command('ping',      (ctx) => ctx.reply('🦙 Duartly online!'));
bot.command('hoje',      handleHoje);
bot.command('resumo',    handleResumo);
bot.command('mes',       handleMes);
bot.command('parcelas',  handleParcelas);
bot.command('insights',  handleInsights);
bot.command('dashboard', handleDashboard);

// ============================================================
// ROTEADOR INTELIGENTE
// ============================================================
bot.on('text', async (ctx) => {
  const texto = ctx.message.text;
  const usuarioId = ctx.usuario.id;

  // 1. Verificar se está no meio do fluxo de cartão
  const interceptado = await handleTextoCartao(ctx);
  if (interceptado) return;

  // 2. Rotear com Gemini
  const prompt = `
Analise a mensagem e responda APENAS com JSON valido, sem markdown.
Mensagem: "${texto}"
{ "intencao": "gasto" | "consulta" | "conversa" }
Regras:
- "gasto": menciona valor, compra, pagamento, despesa ou receita
- "consulta": pergunta sobre financas, gastos, historico, relatorio
- "conversa": qualquer outra coisa
`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const json = JSON.parse(resultado.response.text().replace(/```json|```/g, '').trim());

    if (json.intencao === 'gasto') {
      const msg = await ctx.reply('🦙 Analisando...');
      const classificacao = await classificarGasto(texto);

      if (!classificacao || !classificacao.valor) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, null,
          `🦙 Nao consegui identificar um gasto.\n\nTenta assim:\n- "Padaria 18,50"\n- "Uber 22"\n- "Nike 300 em 3x"`
        );
        return;
      }

      // Se parcelado → fluxo de cartão
      if (classificacao.parcelado && classificacao.total_parcelas > 1) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
        classificacao.raw_input = texto;
        await iniciarFluxoCartao(ctx, classificacao);
        return;
      }

      // Gasto simples → salvar direto
      const resultado2 = await salvarTransacao(usuarioId, classificacao, 'texto', texto);
      const transacao = resultado2.transacoes[0];
      const alertaMeta = await verificarMetas(usuarioId, transacao.categoria_id);

      const emoji = classificacao.tipo === 'receita' ? '💵' : '💸';
      const sinal = classificacao.tipo === 'receita' ? '+' : '-';
      let resposta =
        `${emoji} ${classificacao.descricao}\n` +
        `💰 ${sinal}R$ ${classificacao.valor.toFixed(2)}\n` +
        `🏷️ ${classificacao.categoria}\n` +
        `✅ Registrado!`;

      if (alertaMeta) {
        resposta += `\n\n⚠️ Atencao! Voce ja usou ${alertaMeta.percentual}% da sua meta de ${classificacao.categoria}!`;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        resposta,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '↩️ Desfazer', callback_data: `desfazer_${transacao.id}` }
            ]]
          }
        }
      );

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

// ============================================================
// CONVERSA CASUAL
// ============================================================
async function handleConversa(ctx, texto) {
  const nome = ctx.from.first_name || 'amigo';
  const prompt = `
Voce e o Duartly, uma lhama financeira brasileira bem-humorada e direta.
Responda em NO MAXIMO 2 frases curtas. Sem asteriscos ou markdown.
REGRA: sempre termine redirecionando pro proposito financeiro do app.
Use ganchos como: "Falando nisso, o que voce consumiu hoje?", "Me manda um gasto!", "Bora ver no que voce gastou?"
Mensagem: "${texto}"
Nome: ${nome}
`;
  try {
    const resultado = await modeloConversa.generateContent(prompt);
    await ctx.reply(resultado.response.text().trim());
  } catch (err) {
    await ctx.reply('🦙 Haha! Mas vamos ao que interessa — me manda um gasto ou use /hoje!');
  }
}

// ============================================================
// CALLBACKS — botões inline
// ============================================================
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('desfazer_')) {
    await handleDesfazer(ctx);
    return;
  }

  if (
    data.startsWith('cartao_') ||
    data.startsWith('venc_') ||
    data.startsWith('parcela_') ||
    data.startsWith('nome_')
  ) {
    await handleCallbackCartao(ctx);
    return;
  }
});

// Foto e voz
bot.on('photo', handleFoto);
bot.on('voice', handleVoz);

// Erros
bot.catch((err, ctx) => {
  console.error('Erro no bot:', err);
  ctx.reply('🦙 Ops! Algo deu errado. Tenta de novo!').catch(() => {});
});

bot.launch()
  .then(() => console.log('🦙 Duartly v2 rodando!'))
  .catch((err) => {
    console.error('Erro ao iniciar bot:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
