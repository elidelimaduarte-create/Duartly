// src/services/geminiService.js
const { modeloClassificacao, modeloConversa } = require('../config/gemini');
const supabase = require('../config/supabase');

// ============================================================
// DATA DE BRASÍLIA (UTC-3)
// ============================================================
function getDataBrasilia() {
  const agora = new Date();
  // Ajusta para UTC-3
  const brasilia = new Date(agora.getTime() - (3 * 60 * 60 * 1000));
  return brasilia.toISOString().split('T')[0];
}

function getAgoraBrasilia() {
  const agora = new Date();
  return new Date(agora.getTime() - (3 * 60 * 60 * 1000));
}

// ============================================================
// CLASSIFICAR GASTO EM TEXTO
// ============================================================
async function classificarGasto(texto) {
  const hoje = getDataBrasilia();
  const prompt = `
Voce e um assistente financeiro brasileiro. Analise o texto abaixo e extraia as informacoes de gasto ou receita.
Hoje e ${hoje} (horario de Brasilia).

Texto: "${texto}"

Responda APENAS com um JSON valido neste formato exato:
{
  "descricao": "nome do gasto ou receita",
  "valor": 00.00,
  "tipo": "gasto" ou "receita",
  "categoria": "uma das categorias abaixo",
  "parcelado": false,
  "total_parcelas": null,
  "confianca": 0.00
}

Categorias disponiveis (use exatamente como escrito):
Alimentacao, Transporte, Moradia, Saude, Lazer, Educacao, Vestuario, Mercado, Delivery, Assinaturas, Investimentos, Receita, Outros

Regras:
- Se mencionar "x" parcelas, "vezes", "x" ou "/x", e parcelado (ex: "3x", "em 3 vezes", "3/12")
- Valores em reais: "18,50" = 18.50, "1.200" = 1200.00
- "salario", "renda", "recebi" = tipo receita, categoria Receita
- Delivery (iFood, Rappi, Uber Eats) = categoria Delivery
- Uber, 99, taxi, combustivel = categoria Transporte
- Mercado, supermercado, feira = categoria Mercado
- confianca: 0.0 a 1.0
- Se nao conseguir identificar valor, retorne null no valor
`;

  try {
    const resultado = await modeloClassificacao.generateContent(prompt);
    const texto_resposta = resultado.response.text();
    const json = JSON.parse(texto_resposta.replace(/```json|```/g, '').trim());
    return json;
  } catch (err) {
    console.error('Erro ao classificar gasto:', err);
    return null;
  }
}

// ============================================================
// CLASSIFICAR GASTO DE IMAGEM (CUPOM)
// ============================================================
async function classificarImagemCupom(imagemBase64, mimeType) {
  const prompt = `
Voce e um assistente financeiro brasileiro. Analise esta imagem de cupom fiscal ou comprovante de pagamento.

Extraia TODAS as informacoes relevantes e responda APENAS com um JSON valido:
{
  "descricao": "nome do estabelecimento ou produto principal",
  "valor": 00.00,
  "tipo": "gasto",
  "categoria": "categoria correta",
  "parcelado": false,
  "total_parcelas": null,
  "confianca": 0.00,
  "itens": ["item1", "item2"]
}

Categorias: Alimentacao, Transporte, Moradia, Saude, Lazer, Educacao, Vestuario, Mercado, Delivery, Assinaturas, Investimentos, Receita, Outros
`;

  try {
    const resultado = await modeloClassificacao.generateContent([
      prompt,
      { inlineData: { mimeType, data: imagemBase64 } }
    ]);
    const texto_resposta = resultado.response.text();
    const json = JSON.parse(texto_resposta.replace(/```json|```/g, '').trim());
    return json;
  } catch (err) {
    console.error('Erro ao classificar imagem:', err);
    return null;
  }
}

// ============================================================
// SALVAR TRANSAÇÃO NO SUPABASE
// ============================================================
async function salvarTransacao(usuarioId, classificacao, origem = 'texto', rawInput = '') {
  const { data: categorias } = await supabase
    .from('categorias')
    .select('id, nome')
    .or(`usuario_id.eq.${usuarioId},padrao.eq.true`)
    .ilike('nome', classificacao.categoria);

  const categoriaId = categorias?.[0]?.id || null;

  if (classificacao.parcelado && classificacao.total_parcelas > 1) {
    return await salvarParcelas(usuarioId, classificacao, categoriaId, origem, rawInput);
  }

  // Usa data de Brasília
  const dataBrasilia = getDataBrasilia();

  const { data, error } = await supabase
    .from('transacoes')
    .insert({
      usuario_id:      usuarioId,
      categoria_id:    categoriaId,
      descricao:       classificacao.descricao,
      valor:           classificacao.valor,
      tipo:            classificacao.tipo,
      origem:          origem,
      raw_input:       rawInput,
      confianca_ia:    classificacao.confianca,
      parcelado:       false,
      data_transacao:  dataBrasilia,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao salvar: ${error.message}`);
  return { transacoes: [data], parcelado: false };
}

// ============================================================
// SALVAR PARCELAS
// ============================================================
async function salvarParcelas(usuarioId, classificacao, categoriaId, origem, rawInput) {
  const grupoParcela = crypto.randomUUID();
  const valorParcela = (classificacao.valor / classificacao.total_parcelas).toFixed(2);
  const hoje = getAgoraBrasilia();
  const transacoes = [];

  for (let i = 1; i <= classificacao.total_parcelas; i++) {
    const dataTransacao = new Date(hoje);
    dataTransacao.setMonth(hoje.getMonth() + (i - 1));

    const { data, error } = await supabase
      .from('transacoes')
      .insert({
        usuario_id:     usuarioId,
        categoria_id:   categoriaId,
        descricao:      `${classificacao.descricao} (${i}/${classificacao.total_parcelas})`,
        valor:          parseFloat(valorParcela),
        tipo:           'gasto',
        origem:         origem,
        raw_input:      rawInput,
        confianca_ia:   classificacao.confianca,
        parcelado:      true,
        parcela_atual:  i,
        total_parcelas: classificacao.total_parcelas,
        grupo_parcela:  grupoParcela,
        data_transacao: dataTransacao.toISOString().split('T')[0],
      })
      .select()
      .single();

    if (error) throw new Error(`Erro ao salvar parcela ${i}: ${error.message}`);
    transacoes.push(data);
  }

  return { transacoes, parcelado: true, total_parcelas: classificacao.total_parcelas };
}

// ============================================================
// VERIFICAR METAS E ALERTAR
// ============================================================
async function verificarMetas(usuarioId, categoriaId) {
  if (!categoriaId) return null;

  const agora = getAgoraBrasilia();
  const mes = agora.getMonth() + 1;
  const ano = agora.getFullYear();

  const { data: meta } = await supabase
    .from('metas')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('categoria_id', categoriaId)
    .eq('mes', mes)
    .eq('ano', ano)
    .single();

  if (!meta || meta.alerta_80) return null;

  const { data: gastos } = await supabase
    .from('transacoes')
    .select('valor')
    .eq('usuario_id', usuarioId)
    .eq('categoria_id', categoriaId)
    .eq('tipo', 'gasto')
    .eq('cancelado', false)
    .gte('data_transacao', `${ano}-${String(mes).padStart(2, '0')}-01`);

  const totalGasto = gastos?.reduce((acc, t) => acc + parseFloat(t.valor), 0) || 0;
  const percentual = (totalGasto / parseFloat(meta.valor_limite)) * 100;

  if (percentual >= 80) {
    await supabase
      .from('metas')
      .update({ alerta_80: true })
      .eq('id', meta.id);

    return {
      percentual: Math.round(percentual),
      totalGasto,
      limite: meta.valor_limite
    };
  }

  return null;
}

module.exports = {
  classificarGasto,
  classificarImagemCupom,
  salvarTransacao,
  verificarMetas
};
