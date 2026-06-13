const supabase = require('../config/supabase');

async function obterOuCriarUsuario(ctx) {
  const telegramId = ctx.from.id;
  const nome = ctx.from.first_name || '';
  const username = ctx.from.username || '';

  const { data: existente } = await supabase
    .from('usuarios')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (existente) return existente;

  const { data: novo, error } = await supabase
    .from('usuarios')
    .insert({ telegram_id: telegramId, nome, username })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar usuário: ${error.message}`);

  await supabase.from('jobs_agendados').insert([
    { usuario_id: novo.id, tipo: 'relatorio_semanal' },
    { usuario_id: novo.id, tipo: 'relatorio_mensal' },
  ]);

  console.log(`✅ Novo usuário: ${nome} (${telegramId})`);
  return novo;
}

module.exports = { obterOuCriarUsuario };
