require('dotenv').config();
const { Telegraf } = require('telegraf');
const { obterOuCriarUsuario } = require('./services/usuarioService');
const { iniciarHealthCheck } = require('./healthcheck');
const { handleFoto, handleVoz, handleDesfazer } = require('./handlers/mensagemHandler');
const { handleHoje, handleResumo, handleMes, handleParcelas, handleInsights, handlePerguntaLivre } = require('./handlers/consultaHandler');
const { handleCallbackCartao, handleTextoCartao, iniciarFluxoCartao } = require('./handlers/cartaoHandler');
const { handleDashboard } = require('./handlers/dashboardHandler');
const { handleDefinirMeta, handleVerMetas, handleCallbackMeta, handleTextoMeta } = require('./handlers/metaHandler');
const { handleAgente, handleCallbackAgente, handleTextoAgente } = require('./handlers/agenteCustomHandler');
const { handleRelatorio } = require('./handlers/relatorioHandler');
const { middlewareAcesso, handleAssinar, handleConvite, handleCancelar, handleCallbackCancelamento, handleStartComConvite, handleStartNormal } = require('./handlers/acessoHandler');
const { handleEditar, handleCallbackEditar, handleTextoEditar } = require('./handlers/editarHandler');
const { iniciarOnboarding, verificarOnboarding, handleCallbackOnboarding, ehUsuarioNovo } = require('./handlers/onboardingHandler');
const { handleContas, handleCallbackContas, handleCallbackContasCategoria, handleTextoContas } = require('./handlers/contasHandler');
const { classificarGasto, salvarTransacao, verificarMetas } = require('./services/geminiService');
const { modeloConversa } = require('./config/gemini');
const { iniciarAgentes, executarCuzco, executarLuna, executarInti } = require('./agents/agentes');
const { verificarExpiracoes } = require('./services/assinaturaService');
const cron = require('node-cron');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware: registra usuário
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try { ctx.usuario = await obterOuCriarUsuario(ctx); }
  catch (err) { console.error('Erro no middleware:', err); }
  return next();
});

// Middleware: controle de acesso
bot.use(middlewareAcesso);

// /start
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const usuario = ctx.usuario;

  if (payload && payload.length > 3) {
    await handleStartComConvite(ctx, payload.toUpperCase());
  } else {
    await handleStartNormal(ctx);
  }

  // Onboarding para usuários novos
  if (usuario && await ehUsuarioNovo(usuario.id)) {
    setTimeout(() => iniciarOnboarding(ctx), 2000);
  }
});

bot.help(async (ctx) => {
  await ctx.reply(
    `🦙 O que eu sei fazer:\n\n` +
    `Registrar gastos:\n"Almoco 35", "Uber 22", "Nike 300 em 3x"\n\n` +
    `Ou manda foto do cupom ou audio!\n\n` +
    `Consultas:\n/hoje /resumo /mes /parcelas /insights\n\n` +
    `Relatorio:\n/relatorio - PDF completo do mes\n\n` +
    `Metas:\n/meta - definir meta\n/metas - ver progresso\n\n` +
    `Dashboard:\n/dashboard - painel web completo\n\n` +
    `Editar:\n/editar - corrigir ultimo lancamento\n\n` +
    `Agentes:\n/agente - criar alertas personalizados\n\n` +
    `Conta:\n/assinar /convite /cancelar\n\n` +
    `Agentes autonomos:\n🦙 /cuzco 🌙 /luna ☀️ /inti`
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
bot.command('meta',      handleDefinirMeta);
bot.command('metas',     handleVerMetas);
bot.command('agente',    handleAgente);
bot.command('relatorio', handleRelatorio);
bot.command('contas',    handleContas);
bot.command('assinar',   handleAssinar);
bot.command('convite',   handleConvite);
bot.command('cancelar',  handleCancelar);
bot.command('editar',    handleEditar);

bot.command('cuzco', async (ctx) => { await ctx.reply('🦙 Chamando o Cuzco...'); await executarCuzco(bot); });
bot.command('luna',  async (ctx) => { await ctx.reply('🌙 Chamando a Luna...'); await executarLuna(bot); });
bot.command('inti',  async (ctx) => { await ctx.reply('☀️ Chamando o Inti...'); await executarInti(bot); });

// Roteador
bot.on('text', async (ctx) => {
  const texto = ctx.message.text;
  const usuarioId = ctx.usuario.id;

  if (await handleTextoMeta(ctx)) return;
  if (await handleTextoAgente(ctx)) return;
  if (await handleTextoCartao(ctx)) return;
  if (await handleTextoEditar(ctx)) return;
  if (await handleTextoContas(ctx)) return;

  const prompt = `Analise a mensagem e responda APENAS com JSON valido.
Mensagem: "${texto}"
{ "intencao": "gasto" | "consulta" | "conversa" }
- "gasto": valor, compra, pagamento, despesa, receita
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

      // Verificar onboarding após primeiro gasto
      await verificarOnboarding(ctx);

    } else if (json.intencao === 'consulta') {
      await handlePerguntaLivre(ctx, texto);
    } else {
      const nome = ctx.from.first_name || 'amigo';
      const prompt2 = `Voce e o Duartly, lhama financeira brasileira bem-humorada. Max 2 frases. Sem markdown. Sempre redirecione para financas. Mensagem: "${texto}" Nome: ${nome}`;
      const r = await modeloConversa.generateContent(prompt2);
      await ctx.reply(r.response.text().trim());
    }
  } catch (err) {
    console.error('Erro no roteador:', err);
    await ctx.reply('🦙 Ops! Algo deu errado. Tenta de novo!');
  }
});

// Callbacks
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === 'confirmar_cancelamento' || data === 'manter_assinatura') { await handleCallbackCancelamento(ctx); return; }
  if (data.startsWith('desfazer_'))   { await handleDesfazer(ctx); return; }
  if (data.startsWith('meta_'))       { await handleCallbackMeta(ctx); return; }
  if (data.startsWith('ac_'))         { await handleCallbackAgente(ctx); return; }
  if (data.startsWith('editar_'))     { await handleCallbackEditar(ctx); return; }
  if (data.startsWith('onboarding_')) { await handleCallbackOnboarding(ctx); return; }
  if (data.startsWith('contas_cat_')) { await handleCallbackContasCategoria(ctx); return; }
  if (data.startsWith('contas_'))     { await handleCallbackContas(ctx); return; }
  if (data === 'usar_convite')        { await ctx.answerCbQuery(); await ctx.reply('Digite seu codigo de convite:'); return; }
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
    iniciarHealthCheck(bot);
    iniciarAgentes(bot);

    cron.schedule('0 10 * * *', () => {
      verificarExpiracoes(bot);
    }, { timezone: 'America/Sao_Paulo' });
  })
  .catch((err) => {
    console.error('Erro ao iniciar:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
