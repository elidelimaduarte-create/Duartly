// src/handlers/mensagemHandler.js
const { classificarGasto, classificarImagemCupom, salvarTransacao, verificarMetas } = require('../services/geminiService');
const supabase = require('../config/supabase');

// ============================================================
// HANDLER: TEXTO
// ============================================================
async function handleTexto(ctx) {
  const texto = ctx.message.text;
  const usuarioId = ctx.usuario.id;

  // Ignorar comandos (começam com /)
  if (texto.startsWith('/')) return;

  const msg = await ctx.reply('🦙 Analisando...', { parse_mode: 'Markdown' });

  try {
    const classificacao = await classificarGasto(texto);

    if (!classificacao || !classificacao.valor) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `🦙 Não consegui identificar um gasto nessa mensagem.\n\nTenta assim:\n• "Padaria 18,50"\n• "Uber 22"\n• "Nike 300 em 3x"`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Salvar no banco
    const resultado = await salvarTransacao(usuarioId, classificacao, 'texto', texto);
    const transacao = resultado.transacoes[0];

    // Verificar metas
    const alertaMeta = await verificarMetas(usuarioId, transacao.categoria_id);

    // Montar resposta
    let resposta = formatarConfirmacao(classificacao, resultado);

    if (alertaMeta) {
      resposta += `\n\n⚠️ *Atenção!* Você já usou ${alertaMeta.percentual}% da sua meta de ${classificacao.categoria} esse mês! (R$ ${alertaMeta.totalGasto.toFixed(2)} de R$ ${alertaMeta.limite})`;
    }

    // Adicionar botão de desfazer
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      resposta,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '↩️ Desfazer', callback_data: `desfazer_${transacao.id}` }
          ]]
        }
      }
    );

    // Salvar no contexto de conversa
    await salvarContexto(usuarioId, 'user', texto);
    await salvarContexto(usuarioId, 'model', resposta);

  } catch (err) {
    console.error('Erro no handleTexto:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ops! Algo deu errado. Tenta de novo!'
    );
  }
}

// ============================================================
// HANDLER: FOTO (CUPOM)
// ============================================================
async function handleFoto(ctx) {
  const msg = await ctx.reply('📸 Lendo o cupom...', { parse_mode: 'Markdown' });

  try {
    // Pegar a maior resolução da foto
    const foto = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(foto.file_id);

    // Baixar a imagem
    const response = await fetch(fileLink.href);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const classificacao = await classificarImagemCupom(base64, 'image/jpeg');

    if (!classificacao || !classificacao.valor) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        '🦙 Não consegui ler o cupom. Tenta uma foto mais nítida ou digita o gasto manualmente!'
      );
      return;
    }

    const usuarioId = ctx.usuario.id;
    const resultado = await salvarTransacao(usuarioId, classificacao, 'foto', 'foto_cupom');
    const transacao = resultado.transacoes[0];
    const alertaMeta = await verificarMetas(usuarioId, transacao.categoria_id);

    let resposta = `📸 *Cupom lido!*\n\n` + formatarConfirmacao(classificacao, resultado);

    if (alertaMeta) {
      resposta += `\n\n⚠️ *Atenção!* Você já usou ${alertaMeta.percentual}% da sua meta de ${classificacao.categoria}!`;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      resposta,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '↩️ Desfazer', callback_data: `desfazer_${transacao.id}` }
          ]]
        }
      }
    );

  } catch (err) {
    console.error('Erro no handleFoto:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ops! Erro ao processar a foto. Tenta de novo!'
    );
  }
}

// ============================================================
// HANDLER: VOZ
// ============================================================
async function handleVoz(ctx) {
  const msg = await ctx.reply('🎙️ Transcrevendo áudio...', { parse_mode: 'Markdown' });

  try {
    const voice = ctx.message.voice;
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);

    // Baixar o áudio
    const response = await fetch(fileLink.href);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Usar Gemini para transcrever + classificar
    const { modeloConversa } = require('../config/gemini');

    const prompt = `
Transcreva este áudio em português brasileiro e identifique se é um gasto financeiro.
Se for um gasto, responda APENAS com JSON:
{
  "transcricao": "texto transcrito",
  "descricao": "nome do gasto",
  "valor": 00.00,
  "tipo": "gasto" ou "receita",
  "categoria": "categoria",
  "parcelado": false,
  "total_parcelas": null,
  "confianca": 0.00
}
Categorias: Alimentação, Transporte, Moradia, Saúde, Lazer, Educação, Vestuário, Mercado, Delivery, Assinaturas, Investimentos, Receita, Outros
`;

    const resultado = await modeloConversa.generateContent([
      prompt,
      { inlineData: { mimeType: 'audio/ogg', data: base64 } }
    ]);

    const textoResposta = resultado.response.text();
    const classificacao = JSON.parse(textoResposta.replace(/```json|```/g, '').trim());

    if (!classificacao || !classificacao.valor) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, null,
        `🎙️ Ouvi: _"${classificacao?.transcricao || '...'}"_\n\nNão identifiquei um gasto. Tenta falar o valor também! Ex: "Padaria, vinte reais"`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const usuarioId = ctx.usuario.id;
    const resultadoSalvo = await salvarTransacao(usuarioId, classificacao, 'audio', classificacao.transcricao);
    const transacao = resultadoSalvo.transacoes[0];

    let resposta = `🎙️ _"${classificacao.transcricao}"_\n\n` + formatarConfirmacao(classificacao, resultadoSalvo);

    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      resposta,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '↩️ Desfazer', callback_data: `desfazer_${transacao.id}` }
          ]]
        }
      }
    );

  } catch (err) {
    console.error('Erro no handleVoz:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Ops! Erro ao processar o áudio. Tenta digitar o gasto!'
    );
  }
}

// ============================================================
// HANDLER: DESFAZER (callback do botão)
// ============================================================
async function handleDesfazer(ctx) {
  const transacaoId = ctx.callbackQuery.data.replace('desfazer_', '');
  const usuarioId = ctx.usuario.id;

  try {
    // Verificar se a transação pertence ao usuário
    const { data: transacao } = await supabase
      .from('transacoes')
      .select('*')
      .eq('id', transacaoId)
      .eq('usuario_id', usuarioId)
      .single();

    if (!transacao) {
      await ctx.answerCbQuery('❌ Transação não encontrada!');
      return;
    }

    // Se for parcelado, cancela todas as parcelas do grupo
    if (transacao.parcelado && transacao.grupo_parcela) {
      await supabase
        .from('transacoes')
        .update({ cancelado: true })
        .eq('grupo_parcela', transacao.grupo_parcela);
    } else {
      await supabase
        .from('transacoes')
        .update({ cancelado: true })
        .eq('id', transacaoId);
    }

    await ctx.answerCbQuery('✅ Desfeito!');
    await ctx.editMessageText(
      `~~${ctx.callbackQuery.message.text}~~\n\n↩️ _Lançamento desfeito_`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    console.error('Erro no handleDesfazer:', err);
    await ctx.answerCbQuery('❌ Erro ao desfazer!');
  }
}

// ============================================================
// HELPERS
// ============================================================
function formatarConfirmacao(classificacao, resultado) {
  const emoji = classificacao.tipo === 'receita' ? '💵' : '💸';
  const sinal = classificacao.tipo === 'receita' ? '+' : '-';
  const categoriaTexto = classificacao.subcategoria
    ? `${classificacao.categoria} › ${classificacao.subcategoria}`
    : classificacao.categoria;

  if (resultado.parcelado) {
    const valorParcela = resultado.valor_parcela
      ? resultado.valor_parcela.toFixed(2)
      : (classificacao.valor / classificacao.total_parcelas).toFixed(2);
    return (
      `${emoji} *${classificacao.descricao}*\n` +
      `💳 ${classificacao.total_parcelas}x de R$ ${valorParcela}\n` +
      `🏷️ ${categoriaTexto}\n` +
      `✅ ${classificacao.total_parcelas} parcelas registradas!`
    );
  }

  return (
    `${emoji} *${classificacao.descricao}*\n` +
    `💰 ${sinal}R$ ${classificacao.valor.toFixed(2)}\n` +
    `🏷️ ${categoriaTexto}\n` +
    `✅ Registrado!`
  );
}

async function salvarContexto(usuarioId, role, conteudo) {
  await supabase.from('mensagens_contexto').insert({ usuario_id: usuarioId, role, conteudo });
}

module.exports = { handleTexto, handleFoto, handleVoz, handleDesfazer };
