require('dotenv').config();
const { Telegraf } = require('telegraf');
const { obterOuCriarUsuario } = require('./services/usuarioService');
const { iniciarHealthCheck } = require('./healthcheck');
const { handleTexto, handleFoto, handleVoz, handleDesfazer } = require('./handlers/mensagemHandler');
const {
  handleHoje, handleResumo, handleMes,
  handleParcelas, handleInsights, handlePerguntaLivre
} = require('./handlers/consultaHandler');
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
    `🦙 Olá, ${nome}! Sou o Duartly, sua lhama financeira pessoal.\n\n` +
    `Me conta um gasto e eu já registro pra você:\n\n` +
    `*Exemplos:*\n` +
    `• "Padaria 18,50"\n` +
    `• "Nike 350 em 3x no crédito"\n` +
    `• "iFood 45"\n\n` +
    `Ou manda uma foto do cupom 📸 ou áudio 🎙️\n\n` +
    `Digite /ajuda para ver tudo que sei fazer! 🦙`,
    { parse_mode: 'Markdown' }
  );
});

// /ajuda
bot.help(async (ctx) => {
  await ctx.reply(
    `🦙 *O que eu sei fazer:*\n\n` +
    `*Registrar gastos — só falar natural:*\n` +
    `"Almoço 35", "Uber 22", "Nike 300 em 3x"\n\n` +
    `*Ou manda:*\n` +
    `📸 Foto do cupom → leio e registro\n` +
    `🎙️ Áudio → transcrevo e registro\n\n` +
    `*Consultas:*\n` +
    `/hoje — gastos do dia\n` +
    `/resumo — semana atual\n` +
    `/mes — fechamento do mês\n` +
    `/parcelas — parcelamentos ativos\n` +
    `/insights — Cuzco analisa seus padrões\n\n` +
    `*Perguntas naturais:*\n` +
    `"Quanto gastei com delivery esse mês?"\n` +
    `"Qual foi meu maior gasto essa semana?"`,
    { parse_mode: 'Markdown' }
  );
});

// Comandos de consulta
bot.command('ping',     (ctx) => ctx.reply('🦙 Duartly online!'));
bot.command('hoje',     handleHoje);
bot.command('resumo',   handleResumo);
bot.command('mes',      handleMes);
bot.command('parcelas', handleParcelas);
bot.command('insights', handleInsights);

// ============================================================
// ROTEADOR INTELIGENTE
// ============================================================
bot.on('text', async (ctx) => {
  const texto = ctx.message.text;

  const prompt = `
Você é o roteador do Duartly, assistente financeiro pessoal.
Analise a mensagem e responda APENAS com JSON válido, sem markdown.

Mensagem: "${texto}"

Retorne exatamente neste formato:
{
  "intencao": "gasto" | "consulta" | "conversa"
}

Regras:
- "gasto": menciona valor, compra, pagamento, despesa ou receita
- "consulta": pergunta sobre finanças, gastos, histórico, relatório
- "conversa": qualquer outra coisa (saudação, curiosidade, etc)
`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const json = JSON.parse(resultado.response.text().replace(/```json|```/g, '').trim());

    if (json.intencao === 'gasto') {
      await handleTexto(ctx);
    } else if (json.intencao === 'consulta') {
      await handlePerguntaLivre(ctx, texto);
    } else {
      await handleConversa(ctx, texto);
    }
  } catch (err) {
    console.error('Erro no roteador:', err);
    await handleTexto(ctx);
  }
});

// ============================================================
// CONVERSA CASUAL — IA com padrão fixo de redirecionamento
// ============================================================
async function handleConversa(ctx, texto) {
  const nome = ctx.from.first_name || 'amigo';

  const prompt = `
Você é o Duartly, uma lhama financeira brasileira bem-humorada e direta.
Responda a mensagem abaixo em NO MÁXIMO 2 frases curtas.

REGRA OBRIGATÓRIA: a resposta SEMPRE deve terminar redirecionando para o propósito financeiro do app.
Use ganchos como: "Falando nisso, o que você consumiu hoje?", "Vamos ao que interessa — me manda um gasto!", "Bora ver no que você gastou?", "Sua carteira que manda aqui! 💰"

Mensagem: "${texto}"
Nome do usuário: ${nome}

Use emojis, seja leve e engraçado. Máximo 2 frases. Sem introduções longas.
`;

  try {
    const resultado = await modeloConversa.generateContent(prompt);
    const resposta = resultado.response.text().trim();
    await ctx.reply(resposta, { parse_mode: 'Markdown' });
  } catch (err) {
    // Fallback sem IA
    await ctx.reply(
      `🦙 Haha, boa! Mas vamos ao que interessa — me manda um gasto ou use /hoje pra ver o que você consumiu!`
    );
  }
}

// Foto e voz
bot.on('photo',          handleFoto);
bot.on('voice',          handleVoz);
bot.on('callback_query', handleDesfazer);

// Erros
bot.catch((err, ctx) => {
  console.error(`Erro no bot:`, err);
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
