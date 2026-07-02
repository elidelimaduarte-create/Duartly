// src/handlers/faturaHandler.js
const supabase = require('../config/supabase');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelo = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const sessoes = new Map();

function salvarSessao(id, dados) {
  sessoes.set(String(id), { ...dados, timestamp: Date.now() });
}
function buscarSessao(id) {
  const s = sessoes.get(String(id));
  if (!s || Date.now() - s.timestamp > 10 * 60 * 1000) { sessoes.delete(String(id)); return null; }
  return s;
}
function limparSessao(id) { sessoes.delete(String(id)); }

function getDataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function gerarHash(descricao, totalParcelas, cartaoId) {
  const base = `${descricao.toLowerCase().replace(/[^a-z0-9]/g, '')}-${totalParcelas}-${cartaoId || 'sem'}`;
  return base;
}

function limparDescricao(desc) {
  return desc.replace(/\s+\d+\/\d+\s*$/, '').replace(/\s+parcela\s+\d+\s+de\s+\d+/i, '').trim();
}

// ============================================================
// /fatura — Início do fluxo
// ============================================================
async function handleFatura(ctx) {
  const usuarioId = ctx.usuario.id;

  const { data: cartoes } = await supabase
    .from('cartoes').select('id, nome, dia_vencimento')
    .eq('usuario_id', usuarioId).order('nome');

  if (!cartoes || cartoes.length === 0) {
    await ctx.reply(
      '💳 Voce nao tem cartoes cadastrados!\n\nUse /cartao para cadastrar um cartao antes de importar faturas.'
    );
    return;
  }

  salvarSessao(usuarioId, { etapa: 'aguardando_cartao' });

  const botoes = cartoes.map(c => ([{
    text: `💳 ${c.nome} (vence dia ${c.dia_vencimento})`,
    callback_data: `fatura_cartao_${c.id}`
  }]));
  botoes.push([{ text: '❌ Cancelar', callback_data: 'fatura_cancelar' }]);

  await ctx.reply(
    '📄 Importar Fatura\n\nQual cartao e essa fatura?',
    { reply_markup: { inline_keyboard: botoes } }
  );
}

// ============================================================
// CALLBACKS
// ============================================================
async function handleCallbackFatura(ctx) {
  const data = ctx.callbackQuery.data;
  const usuarioId = ctx.usuario.id;
  await ctx.answerCbQuery();

  if (data === 'fatura_cancelar') {
    await ctx.editMessageText('🦙 Importacao cancelada!');
    limparSessao(usuarioId);
    return;
  }

  // ── SELECIONOU CARTÃO
  if (data.startsWith('fatura_cartao_')) {
    const cartaoId = data.replace('fatura_cartao_', '');

    const { data: cartao } = await supabase
      .from('cartoes').select('*').eq('id', cartaoId).single();

    salvarSessao(usuarioId, { etapa: 'aguardando_pdf', cartaoId, cartao });

    await ctx.editMessageText(
      `💳 ${cartao.nome} selecionado!\n\nAgora manda o PDF da fatura.\n\n⚠️ Certifique-se que e o PDF original do banco, nao uma foto.`
    );
    return;
  }

  // ── CONFIRMAR IMPORTAÇÃO
  if (data.startsWith('fatura_confirmar_')) {
    const sessao = buscarSessao(usuarioId);
    if (!sessao?.lancamentos) { await ctx.editMessageText('🦙 Sessao expirada. Use /fatura novamente.'); return; }

    await ctx.editMessageText('⏳ Salvando lancamentos...');
    await salvarLancamentos(ctx, sessao);
    return;
  }

  // ── CANCELAR IMPORTAÇÃO
  if (data === 'fatura_cancelar_import') {
    limparSessao(usuarioId);
    await ctx.editMessageText('🦙 Importacao cancelada!');
    return;
  }
}

// ============================================================
// HANDLER PDF
// ============================================================
async function handlePdfFatura(ctx) {
  const usuarioId = ctx.usuario.id;
  const sessao = buscarSessao(usuarioId);

  if (!sessao || sessao.etapa !== 'aguardando_pdf') return false;

  const doc = ctx.message?.document;
  if (!doc || doc.mime_type !== 'application/pdf') {
    await ctx.reply('Por favor manda um arquivo PDF da fatura.');
    return true;
  }

  const msg = await ctx.reply('📄 Lendo fatura com IA... Aguarde!');

  try {
    // Baixar PDF do Telegram
    const file = await ctx.telegram.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Enviar para Gemini
    const hoje = getDataBrasilia();
    const mesAtual = hoje.getMonth() + 1;
    const anoAtual = hoje.getFullYear();

    const prompt = `
Voce e um especialista em faturas de cartao de credito brasileiro.
Analise esta fatura e extraia TODOS os lancamentos.
Hoje e ${hoje.toLocaleDateString('pt-BR')}. Mes atual: ${mesAtual}/${anoAtual}.

Para cada lancamento retorne um JSON array com objetos:
{
  "descricao": "nome limpo do estabelecimento sem numero de parcela",
  "valor": 00.00,
  "tipo": "gasto" ou "receita",
  "data": "YYYY-MM-DD",
  "parcelado": true ou false,
  "parcela_atual": 1,
  "total_parcelas": 1,
  "categoria": "Alimentacao|Transporte|Moradia|Saude|Lazer|Educacao|Vestuario|Mercado|Delivery|Assinaturas|Investimentos|Receita|Outros",
  "subcategoria": "nome da subcategoria ou null",
  "internacional": false,
  "moeda_original": "BRL",
  "valor_original": 00.00
}

REGRAS CRITICAS:
- Estornos e cashback = tipo "receita"
- Valor SEMPRE em reais (convertido se internacional)
- descricao: nome limpo SEM "2/6" ou "Parcela X de Y"
- Para parcelados: extraia parcela_atual e total_parcelas do texto (ex: "2/6" = parcela_atual:2, total_parcelas:6)
- IOF, juros, encargos = categoria "Outros"
- Se nao conseguir identificar, retorne array vazio []

Responda APENAS com o JSON array, sem texto adicional, sem markdown.
`;

    const result = await modelo.generateContent([
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      prompt
    ]);

    const texto = result.response.text().replace(/```json|```/g, '').trim();
    const lancamentos = JSON.parse(texto);

    if (!lancamentos || lancamentos.length === 0) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
        '🦙 Nao consegui ler os lancamentos da fatura. Tenta outro PDF ou digita os gastos manualmente.'
      );
      return true;
    }

    // Verificar fatura já importada
    const mesFatura = lancamentos[0]?.data ? parseInt(lancamentos[0].data.split('-')[1]) : mesAtual;
    const anoFatura = lancamentos[0]?.data ? parseInt(lancamentos[0].data.split('-')[0]) : anoAtual;

    const { data: faturaExistente } = await supabase
      .from('faturas_importadas')
      .select('id, total_lancamentos, importado_em')
      .eq('usuario_id', usuarioId)
      .eq('cartao_id', sessao.cartaoId)
      .eq('mes', mesFatura)
      .eq('ano', anoFatura)
      .single();

    salvarSessao(usuarioId, {
      ...sessao,
      etapa: 'aguardando_confirmacao',
      lancamentos,
      mesFatura,
      anoFatura,
      faturaExistente
    });

    // Montar resumo
    const gastos = lancamentos.filter(l => l.tipo === 'gasto');
    const receitas = lancamentos.filter(l => l.tipo === 'receita');
    const totalGastos = gastos.reduce((a, l) => a + l.valor, 0);
    const totalReceitas = receitas.reduce((a, l) => a + l.valor, 0);
    const parcelados = lancamentos.filter(l => l.parcelado && l.total_parcelas > 1);

    let resumo = `📄 *Fatura ${sessao.cartao.nome} — ${mesFatura}/${anoFatura}*\n\n`;
    resumo += `💸 ${gastos.length} gastos: R$ ${totalGastos.toFixed(2)}\n`;
    if (receitas.length > 0) resumo += `💵 ${receitas.length} estornos: R$ ${totalReceitas.toFixed(2)}\n`;
    if (parcelados.length > 0) resumo += `💳 ${parcelados.length} parcelamentos identificados\n`;
    resumo += `\n*Primeiros lancamentos:*\n`;

    lancamentos.slice(0, 5).forEach(l => {
      const sinal = l.tipo === 'receita' ? '+' : '-';
      const parc = l.parcelado && l.total_parcelas > 1 ? ` (${l.parcela_atual}/${l.total_parcelas})` : '';
      resumo += `${sinal}R$ ${l.valor.toFixed(2)} ${l.descricao}${parc}\n`;
    });
    if (lancamentos.length > 5) resumo += `... e mais ${lancamentos.length - 5} lancamentos\n`;

    if (faturaExistente) {
      resumo += `\n⚠️ *Atencao:* Voce ja importou esta fatura em ${new Date(faturaExistente.importado_em).toLocaleDateString('pt-BR')}.\n`;
      resumo += `Serao adicionados apenas lancamentos novos e parcelamentos atualizados.`;
    }

    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, resumo, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirmar importacao', callback_data: `fatura_confirmar_${usuarioId}` }],
          [{ text: '❌ Cancelar', callback_data: 'fatura_cancelar_import' }]
        ]
      }
    });

  } catch (err) {
    console.error('Erro ao ler fatura:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
      '🦙 Erro ao processar a fatura. Verifique se o PDF esta correto e tente novamente.'
    );
  }

  return true;
}

// ============================================================
// SALVAR LANÇAMENTOS
// ============================================================
async function salvarLancamentos(ctx, sessao) {
  const usuarioId = ctx.usuario.id;
  const { lancamentos, cartaoId, cartao, mesFatura, anoFatura } = sessao;
  const hoje = getDataBrasilia();
  const mesAtual = hoje.getMonth() + 1;
  const anoAtual = hoje.getFullYear();

  let adicionados = 0, ignorados = 0, atualizados = 0;

  for (const lanc of lancamentos) {
    try {
      // Buscar categoria
      const { data: cats } = await supabase
        .from('categorias').select('id').eq('padrao', true)
        .ilike('nome', lanc.categoria).eq('nivel', 1).limit(1);
      const categoriaId = cats?.[0]?.id || null;

      // Buscar subcategoria
      let subcategoriaId = null;
      if (lanc.subcategoria && categoriaId) {
        const { data: subcats } = await supabase
          .from('categorias').select('id')
          .ilike('nome', lanc.subcategoria)
          .eq('categoria_pai_id', categoriaId).limit(1);
        subcategoriaId = subcats?.[0]?.id || null;
      }

      // ── PARCELAMENTO
      if (lanc.parcelado && lanc.total_parcelas > 1) {
        const descLimpa = limparDescricao(lanc.descricao);
        const hash = gerarHash(descLimpa, lanc.total_parcelas, cartaoId);

        // Verificar se grupo já existe no banco
        const { data: existentes } = await supabase
          .from('transacoes')
          .select('id, parcela_atual, valor, data_transacao, grupo_parcela')
          .eq('usuario_id', usuarioId)
          .eq('grupo_parcela_hash', hash)
          .eq('cancelado', false)
          .order('parcela_atual');

        if (existentes && existentes.length > 0) {
          // Grupo já existe — verificar se valor mudou (Opção B)
          const grupoParcela = existentes[0].grupo_parcela;
          const parcelaAtualExistente = existentes.find(e => e.parcela_atual === lanc.parcela_atual);

          if (parcelaAtualExistente && Math.abs(parseFloat(parcelaAtualExistente.valor) - lanc.valor) > 0.01) {
            // Valor mudou — atualiza parcela atual e futuras
            await supabase.from('transacoes').update({ valor: lanc.valor })
              .eq('grupo_parcela', grupoParcela)
              .gte('parcela_atual', lanc.parcela_atual);
            atualizados++;
          } else {
            ignorados++;
          }
          continue;
        }

        // Grupo novo — criar parcelas a partir da atual
        const grupoParcela = crypto.randomUUID ? crypto.randomUUID() :
          Math.random().toString(36).substr(2,9) + Date.now();

        const parcelasParaCriar = [];
        for (let i = lanc.parcela_atual; i <= lanc.total_parcelas; i++) {
          const offset = i - lanc.parcela_atual;
          const mesParcela = ((mesAtual - 1 + offset) % 12) + 1;
          const anoParcela = anoAtual + Math.floor((mesAtual - 1 + offset) / 12);
          const dataVenc = new Date(anoParcela, mesParcela - 1, cartao.dia_vencimento);

          parcelasParaCriar.push({
            usuario_id:          usuarioId,
            categoria_id:        categoriaId,
            subcategoria_id:     subcategoriaId,
            cartao_id:           cartaoId,
            descricao:           `${descLimpa} (${i}/${lanc.total_parcelas})`,
            valor:               lanc.valor,
            tipo:                'gasto',
            origem:              'fatura',
            parcelado:           true,
            parcela_atual:       i,
            total_parcelas:      lanc.total_parcelas,
            grupo_parcela:       grupoParcela,
            grupo_parcela_hash:  hash,
            data_transacao:      dataVenc.toISOString().split('T')[0],
            cancelado:           false,
          });
        }

        await supabase.from('transacoes').insert(parcelasParaCriar);
        adicionados++;

      } else {
        // ── LANÇAMENTO SIMPLES
        // Verificar duplicata: mesmo cartao, descricao e data
        const dataLanc = lanc.data || hoje.toISOString().split('T')[0];
        const { data: dupla } = await supabase
          .from('transacoes').select('id')
          .eq('usuario_id', usuarioId)
          .eq('cartao_id', cartaoId)
          .ilike('descricao', lanc.descricao)
          .eq('data_transacao', dataLanc)
          .eq('cancelado', false)
          .limit(1);

        if (dupla && dupla.length > 0) { ignorados++; continue; }

        await supabase.from('transacoes').insert({
          usuario_id:      usuarioId,
          categoria_id:    categoriaId,
          subcategoria_id: subcategoriaId,
          cartao_id:       cartaoId,
          descricao:       lanc.descricao,
          valor:           lanc.valor,
          tipo:            lanc.tipo,
          origem:          'fatura',
          parcelado:       false,
          data_transacao:  dataLanc,
          cancelado:       false,
        });
        adicionados++;
      }
    } catch (err) {
      console.error('Erro ao salvar lancamento:', lanc.descricao, err);
      ignorados++;
    }
  }

  // Registrar fatura importada
  await supabase.from('faturas_importadas').upsert({
    usuario_id:        usuarioId,
    cartao_id:         cartaoId,
    mes:               mesFatura,
    ano:               anoFatura,
    total_lancamentos: lancamentos.length,
    importado_em:      new Date().toISOString()
  }, { onConflict: 'usuario_id,cartao_id,mes,ano' });

  limparSessao(usuarioId);

  await ctx.editMessageText(
    `✅ Fatura importada!\n\n` +
    `➕ ${adicionados} lancamentos adicionados\n` +
    `🔄 ${atualizados} parcelamentos atualizados\n` +
    `⏭️ ${ignorados} ja existiam (ignorados)\n\n` +
    `Use /parcelas para ver seus parcelamentos ativos.`
  );
}

module.exports = { handleFatura, handleCallbackFatura, handlePdfFatura };
