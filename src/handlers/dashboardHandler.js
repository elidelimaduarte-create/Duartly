const supabase = require('../config/supabase');
const crypto = require('crypto');

async function handleDashboard(ctx) {
  const usuarioId = ctx.usuario.id;

  await supabase
    .from('tokens_dashboard')
    .update({ ativo: false })
    .eq('usuario_id', usuarioId);

  const token = crypto.randomBytes(32).toString('hex');
  const expiraEm = new Date();
  expiraEm.setHours(expiraEm.getHours() + 24);

  const { error } = await supabase
    .from('tokens_dashboard')
    .insert({
      usuario_id: usuarioId,
      token,
      ativo: true,
      expira_em: expiraEm.toISOString()
    });

  if (error) {
    await ctx.reply('🦙 Erro ao gerar o dashboard. Tenta de novo!');
    return;
  }

  const url = `https://duartly-dashboard.vercel.app/${token}`;

  await ctx.reply(
    `🦙 Seu dashboard esta pronto!\n\n📊 ${url}\n\n⏱ Link valido por 24 horas.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Abrir Dashboard', url }
        ]]
      }
    }
  );
}

module.exports = { handleDashboard };
