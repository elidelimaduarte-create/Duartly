require('dotenv').config();
const { Telegraf } = require('telegraf');
const { obterOuCriarUsuario } = require('./services/usuarioService');
const { iniciarHealthCheck } = require('./healthcheck');

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
    `🦙 Olá, ${nome}! Sou o Duartly, sua lhama financeira pessoal.\n\n` +
    `Me conta um gasto e eu já registro pra você:\n\n` +
    `*Exemplos:*\n` +
    `• "Padaria 18,50"\n` +
    `• "Nike 350 em 3x no crédito"\n` +
    `• "iFood 45"\n\n` +
    `Ou manda uma foto do cupom 📸\n\n` +
    `Digite /ajuda para ver tudo que sei fazer! 🦙`,
    { parse_mode: 'Markdown' }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🦙 *O que eu sei fazer:*\n\n` +
    `*Registrar gastos* — só falar natural:\n` +
    `"Almoço 35", "Uber 22", "Nike 300 em 3x"\n\n` +
    `*Consultas rápidas:*\n` +
    `/hoje — gastos do dia\n` +
    `/resumo — semana atual\n` +
    `/mes — fechamento do mês\n` +
    `/parcelas — parcelamentos ativos\n` +
    `/metas — suas metas mensais\n` +
    `/insights — análise dos últimos 30 dias\n\n` +
    `*Perguntas em linguagem natural:*\n` +
    `"Quanto gastei com delivery esse mês?"\n` +
    `"Qual foi meu maior gasto essa semana?"\n\n` +
    `*Outros:*\n` +
    `/relatorio — relatório completo com gráfico\n` +
    `/editar — corrigir último lançamento`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('ping', (ctx) => ctx.reply('🦙 Duartly online!'));

bot.on('text', async (ctx) => {
  await ctx.reply(
    `🦙 Recebi: "${ctx.message.text}"\n\n` +
    `_A classificação inteligente vem na Etapa 2!_\n` +
    `Por enquanto, use /ajuda para ver os comandos.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('photo', async (ctx) => {
  await ctx.reply('📸 Recebi a foto! A leitura de cupom chega na Etapa 2. 🦙');
});

bot.on('voice', async (ctx) => {
  await ctx.reply('🎙️ Recebi o áudio! O registro por voz chega na Etapa 2. 🦙');
});

bot.catch((err, ctx) => {
  console.error(`Erro no bot para ${ctx.updateType}:`, err);
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
