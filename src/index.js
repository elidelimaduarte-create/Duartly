require('dotenv').config();
const { Telegraf } = require('telegraf');
const { obterOuCriarUsuario } = require('./services/usuarioService');
const { iniciarHealthCheck } = require('./healthcheck');
const { handleTexto, handleFoto, handleVoz, handleDesfazer } = require('./handlers/mensagemHandler');

iniciarHealthCheck();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware: registra usuário em toda mensagem
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
    `/metas — suas metas mensais\n` +
    `/insights — análise dos últimos 30 dias\n` +
    `/relatorio — relatório completo\n\n` +
    `*Perguntas naturais:*\n` +
    `"Quanto gastei com delivery esse mês?"\n` +
    `"Qual foi meu maior gasto essa semana?"`,
    { parse_mode: 'Markdown' }
  );
});

// /ping
bot.command('ping', (ctx) => ctx.reply('🦙 Duartly online!'));

// Handlers principais
bot.on('text',    handleTexto);
bot.on('photo',   handleFoto);
bot.on('voice',   handleVoz);
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
