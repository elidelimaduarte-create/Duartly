// src/handlers/cartaoHandler.js
const {
  buscarCartoes,
  criarCartao,
  salvarParcelasComCartao,
  salvarSessao,
  buscarSessao,
  limparSessao
} = require('../services/cartaoService');
const supabase = require('../config/supabase');

// ============================================================
// INICIAR FLUXO DE PARCELAMENTO
// Chamado quando Gemini detecta compra parcelada
// ============================================================
async function iniciarFluxoCartao(ctx, classificacao) {
  const usuarioId = ctx.usuario.id;

  // Buscar cartões existentes
  const cartoes = await buscarCartoes(usuarioId);

  // Salvar classificação na sessão
  salvarSessao(usuarioId, {
    etapa: cartoes.length > 0 ? 'escolher_cartao' : 'novo_vencimento',
    classificacao
  });

  if (cartoes.length > 0) {
    // Usuário já tem cartões — mostrar opções
    const botoes = cartoes.map(c => ({
      text: `💳 ${c.nome} (dia ${c.dia_vencimento})`,
      callback_data: `cartao_usar_${c.id}`
    }));

    botoes.push({ text: '➕ Novo cartão', callback_data: 'cartao_novo' });

    await ctx.reply(
      `💳 ${classificacao.descricao} — ${classificacao.total_parcelas}x de R$ ${(classificacao.valor / classificacao.total_parcelas).toFixed(2)}\n\nQual cartão usar?`,
      {
        reply_markup: {
          inline_keyboard: botoes.map(b => [b])
        }
      }
    );
  } else {
    // Primeiro cartão — perguntar vencimento
    await perguntarVencimento(ctx, classificacao);
  }
}

// ============================================================
// PERGUNTAR DIA DE VENCIMENTO
// ============================================================
async function perguntarVencimento(ctx, classificacao) {
  const texto = classificacao
    ? `💳 ${classificacao.descricao} — ${classificacao.total_parcelas}x de R$ ${(classificacao.valor / classificacao.total_parcelas).toFixed(2)}\n\nQual o dia de vencimento da sua fatura?`
    : 'Qual o dia de vencimento da sua fatura?';

  await ctx.reply(texto, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '5', callback_data: 'venc_5' },
          { text: '10', callback_data: 'venc_10' },
          { text: '15', callback_data: 'venc_15' },
          { text: '20', callback_data: 'venc_20' },
        ],
        [
          { text: '25', callback_data: 'venc_25' },
          { text: '1', callback_data: 'venc_1' },
          { text: '28', callback_data: 'venc_28' },
          { text: '🔢 Outro', callback_data: 'venc_outro' },
        ]
      ]
    }
  });
}

// ============================================================
// PERGUNTAR QUANDO CAI A PRIMEIRA PARCELA
// ============================================================
async function perguntarPrimeiraParcela(ctx, diaVencimento) {
  const agora = new Date();
  const mesAtual = agora.toLocaleString('pt-BR', { month: 'long' });
  const mesProximo = new Date(agora.getFullYear(), agora.getMonth() + 1, 1)
    .toLocaleString('pt-BR', { month: 'long' });

  await ctx.reply(
    `📅 Dia ${diaVencimento} anotado!\n\nA primeira parcela cai em qual mês?`,
    {
      reply_markup: {
        inline_keyboard: [[
          {
            text: `Este mês (${mesAtual.charAt(0).toUpperCase() + mesAtual.slice(1)})`,
            callback_data: 'parcela_este_mes'
          },
          {
            text: `Próximo (${mesProximo.charAt(0).toUpperCase() + mesProximo.slice(1)})`,
            callback_data: 'parcela_proximo_mes'
          }
        ]]
      }
    }
  );
}

// ============================================================
// PERGUNTAR NOME DO CARTÃO (opcional)
// ============================================================
async function perguntarNomeCartao(ctx) {
  await ctx.reply(
    `💳 Qual o nome do cartao?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Nubank',    callback_data: 'nome_Nubank'    },
            { text: 'Itau',      callback_data: 'nome_Itau'      },
            { text: 'Bradesco',  callback_data: 'nome_Bradesco'  },
          ], [
            { text: 'Santander', callback_data: 'nome_Santander' },
            { text: 'Inter',     callback_data: 'nome_Inter'     },
            { text: 'C6',        callback_data: 'nome_C6'        },
          ], [
            { text: 'Caixa',     callback_data: 'nome_Caixa'     },
            { text: 'BB',        callback_data: 'nome_BB'        },
            { text: '✏️ Digitar', callback_data: 'nome_digitar'  },
          ]
        ]
      }
    }
  );
}

// ============================================================
// FINALIZAR — salvar parcelas e confirmar
// ============================================================
async function finalizarParcelamento(ctx, cartao, primeiraNoProximoMes) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);
  if (!sessao) {
    await ctx.reply('🦙 Sessao expirada. Tenta registrar o gasto novamente!');
    return;
  }

  const { classificacao } = sessao;

  // Buscar categoria
  const { data: categorias } = await supabase
    .from('categorias')
    .select('id, nome')
    .or(`usuario_id.eq.${usuarioId},padrao.eq.true`)
    .ilike('nome', classificacao.categoria);

  const categoriaId = categorias?.[0]?.id || null;

  try {
    const { transacoes, datas } = await salvarParcelasComCartao(
      usuarioId, classificacao, cartao, primeiraNoProximoMes, categoriaId
    );

    limparSessao(usuarioId);

    const valorParcela = (classificacao.valor / classificacao.total_parcelas).toFixed(2);
    const primeiradata = datas[0].split('-').reverse().join('/');
    const ultimaData = datas[datas.length - 1].split('-').reverse().join('/');

    await ctx.reply(
      `✅ Parcelamento registrado!\n\n` +
      `📦 ${classificacao.descricao}\n` +
      `💳 ${cartao.nome} — ${classificacao.total_parcelas}x de R$ ${valorParcela}\n` +
      `📅 De ${primeiradata} ate ${ultimaData}\n` +
      `💸 Total: R$ ${classificacao.valor.toFixed(2)}`
    );

  } catch (err) {
    console.error('Erro ao finalizar parcelamento:', err);
    await ctx.reply('🦙 Erro ao salvar parcelas. Tenta de novo!');
  }
}

// ============================================================
// HANDLER PRINCIPAL DE CALLBACKS DO CARTÃO
// ============================================================
async function handleCallbackCartao(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  await ctx.answerCbQuery();

  // --- USAR CARTÃO EXISTENTE ---
  if (data.startsWith('cartao_usar_')) {
    const cartaoId = data.replace('cartao_usar_', '');
    const { data: cartao } = await supabase
      .from('cartoes').select('*').eq('id', cartaoId).single();

    salvarSessao(usuarioId, { ...sessao, etapa: 'primeira_parcela', cartao });
    await perguntarPrimeiraParcela(ctx, cartao.dia_vencimento);
    return;
  }

  // --- NOVO CARTÃO ---
  if (data === 'cartao_novo') {
    salvarSessao(usuarioId, { ...sessao, etapa: 'novo_vencimento' });
    await perguntarVencimento(ctx, sessao?.classificacao);
    return;
  }

  // --- DIA DE VENCIMENTO ---
  if (data.startsWith('venc_') && data !== 'venc_outro') {
    const dia = parseInt(data.replace('venc_', ''));
    if (sessao?.modo === 'cadastro_direto') {
      salvarSessao(usuarioId, { ...sessao, etapa: 'nome_cartao', diaVencimento: dia });
      await perguntarNomeCartao(ctx);
    } else {
      salvarSessao(usuarioId, { ...sessao, etapa: 'primeira_parcela', diaVencimento: dia });
      await perguntarPrimeiraParcela(ctx, dia);
    }
    return;
  }

  if (data === 'venc_outro') {
    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_vencimento_texto' });
    await ctx.reply('Digite o dia de vencimento (ex: 7, 12, 22):');
    return;
  }

  // --- PRIMEIRA PARCELA ---
  if (data === 'parcela_este_mes' || data === 'parcela_proximo_mes') {
    const primeiraNoProximoMes = data === 'parcela_proximo_mes';
    salvarSessao(usuarioId, { ...sessao, etapa: 'nome_cartao', primeiraNoProximoMes });
    await perguntarNomeCartao(ctx);
    return;
  }

  // --- NOME DO CARTÃO ---
  if (data === 'nome_digitar') {
    salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_nome_texto' });
    await ctx.reply('Digite o nome do cartao:');
    return;
  }

  if (data.startsWith('nome_')) {
    const nomeCartao = data.replace('nome_', '');
    const sessaoAtual = buscarSessao(usuarioId);
    const cartao = await criarCartao(
      usuarioId,
      nomeCartao,
      sessaoAtual.diaVencimento || sessaoAtual.cartao?.dia_vencimento,
      sessaoAtual.primeiraNoProximoMes
    );

    if (sessaoAtual.modo === 'cadastro_direto') {
      limparSessao(usuarioId);
      await ctx.editMessageText(`✅ Cartao ${cartao.nome} cadastrado! Vencimento dia ${cartao.dia_vencimento}.\n\nAgora use /fatura para importar sua fatura.`);
    } else {
      salvarSessao(usuarioId, { ...sessaoAtual, cartao });
      await finalizarParcelamento(ctx, cartao, sessaoAtual.primeiraNoProximoMes);
    }
    return;
  }
}

// ============================================================
// HANDLER PARA TEXTO DURANTE FLUXO DO CARTÃO
// ============================================================
async function handleTextoCartao(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);
  if (!sessao) return false;

  // Aguardando dia de vencimento digitado
  if (sessao.etapa === 'aguardando_vencimento_texto') {
    const dia = parseInt(ctx.message.text);
    if (isNaN(dia) || dia < 1 || dia > 28) {
      await ctx.reply('Por favor, digite um dia valido entre 1 e 28:');
      return true;
    }
    if (sessao.modo === 'cadastro_direto') {
      salvarSessao(usuarioId, { ...sessao, etapa: 'aguardando_nome_texto', diaVencimento: dia });
      await ctx.reply('Qual o nome do cartao? (ex: Nubank, Itau, Santander)');
    } else {
      salvarSessao(usuarioId, { ...sessao, etapa: 'primeira_parcela', diaVencimento: dia });
      await perguntarPrimeiraParcela(ctx, dia);
    }
    return true;
  }

  // Aguardando nome personalizado do cartão
  if (sessao.etapa === 'aguardando_nome_texto') {
    const nome = ctx.message.text.trim();
    const cartao = await criarCartao(
      usuarioId, nome,
      sessao.diaVencimento,
      sessao.primeiraNoProximoMes
    );
    limparSessao(usuarioId);
    if (sessao.modo === 'cadastro_direto') {
      await ctx.reply(`✅ Cartao ${cartao.nome} cadastrado! Vencimento dia ${cartao.dia_vencimento}.\n\nAgora use /fatura para importar sua fatura.`);
    } else {
      salvarSessao(usuarioId, { ...sessao, cartao });
      await finalizarParcelamento(ctx, cartao, sessao.primeiraNoProximoMes);
    }
    return true;
  }

  return false;
}

// ============================================================
// CADASTRAR CARTÃO DIRETO — /cartao
// ============================================================
async function handleCadastrarCartao(ctx) {
  const usuarioId = ctx.usuario.id;
  const cartoes = await buscarCartoes(usuarioId);

  // Limpar qualquer sessão anterior
  limparSessao(usuarioId);

  // Salvar sessão de cadastro direto (sem classificacao)
  salvarSessao(usuarioId, { etapa: 'novo_vencimento', classificacao: null, modo: 'cadastro_direto' });

  let msg = cartoes.length > 0
    ? `💳 Seus cartoes cadastrados:\n\n${cartoes.map(c => `• ${c.nome} (dia ${c.dia_vencimento})`).join('\n')}\n\n`
    : '💳 Voce ainda nao tem cartoes cadastrados.\n\n';

  msg += 'Qual o dia de vencimento do novo cartao?';

  await ctx.reply(msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Dia 1',  callback_data: 'venc_1'  }, { text: 'Dia 5',  callback_data: 'venc_5'  }, { text: 'Dia 7',  callback_data: 'venc_7'  }],
        [{ text: 'Dia 10', callback_data: 'venc_10' }, { text: 'Dia 12', callback_data: 'venc_12' }, { text: 'Dia 15', callback_data: 'venc_15' }],
        [{ text: 'Dia 20', callback_data: 'venc_20' }, { text: 'Dia 25', callback_data: 'venc_25' }, { text: 'Dia 28', callback_data: 'venc_28' }],
      ]
    }
  });
}

module.exports = {
  iniciarFluxoCartao,
  handleCadastrarCartao,
  handleCallbackCartao,
  handleTextoCartao
};
