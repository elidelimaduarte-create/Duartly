// src/services/cartaoService.js
const supabase = require('../config/supabase');

// ============================================================
// BUSCAR CARTÕES DO USUÁRIO
// ============================================================
async function buscarCartoes(usuarioId) {
  const { data } = await supabase
    .from('cartoes')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('ativo', true)
    .order('criado_em', { ascending: true });
  return data || [];
}

// ============================================================
// CRIAR OU BUSCAR CARTÃO
// ============================================================
async function criarCartao(usuarioId, nome, diaVencimento, primeiraParcelaProximoMes) {
  // Verifica se já existe cartão com esse nome
  const { data: existente } = await supabase
    .from('cartoes')
    .select('*')
    .eq('usuario_id', usuarioId)
    .ilike('nome', nome)
    .single();

  if (existente) return existente;

  const { data, error } = await supabase
    .from('cartoes')
    .insert({
      usuario_id:     usuarioId,
      nome:           nome,
      dia_vencimento: diaVencimento,
      ativo:          true
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar cartão: ${error.message}`);
  return data;
}

// ============================================================
// CALCULAR DATAS DAS PARCELAS
// ============================================================
function calcularDatasParcelas(totalParcelas, diaVencimento, primeiraNoProximoMes) {
  const hoje = new Date();
  const datas = [];

  for (let i = 0; i < totalParcelas; i++) {
    const data = new Date(hoje);

    // Se primeira parcela é no próximo mês, começa +1
    const offset = primeiraNoProximoMes ? i + 1 : i;
    data.setMonth(hoje.getMonth() + offset);
    data.setDate(diaVencimento);

    // Ajuste se o dia não existe no mês (ex: 31 em fevereiro)
    if (data.getDate() !== diaVencimento) {
      data.setDate(0); // último dia do mês anterior
    }

    datas.push(data.toISOString().split('T')[0]);
  }

  return datas;
}

// ============================================================
// SALVAR PARCELAS COM DATAS CORRETAS
// ============================================================
async function salvarParcelasComCartao(usuarioId, classificacao, cartao, primeiraNoProximoMes, categoriaId) {
  const grupoParcela = crypto.randomUUID();
  const totalParcelas = classificacao.total_parcelas;
  const valorParcela = (classificacao.valor / totalParcelas).toFixed(2);

  const datas = calcularDatasParcelas(
    totalParcelas,
    cartao.dia_vencimento,
    primeiraNoProximoMes
  );

  const transacoes = [];

  for (let i = 0; i < totalParcelas; i++) {
    const { data, error } = await supabase
      .from('transacoes')
      .insert({
        usuario_id:     usuarioId,
        categoria_id:   categoriaId,
        cartao_id:      cartao.id,
        descricao:      `${classificacao.descricao} (${i + 1}/${totalParcelas})`,
        valor:          parseFloat(valorParcela),
        tipo:           'gasto',
        origem:         'texto',
        raw_input:      classificacao.raw_input || '',
        confianca_ia:   classificacao.confianca,
        parcelado:      true,
        parcela_atual:  i + 1,
        total_parcelas: totalParcelas,
        grupo_parcela:  grupoParcela,
        data_transacao: datas[i],
      })
      .select()
      .single();

    if (error) throw new Error(`Erro ao salvar parcela ${i + 1}: ${error.message}`);
    transacoes.push(data);
  }

  return { transacoes, datas };
}

// ============================================================
// ESTADO TEMPORÁRIO DA CONVERSA (sessão em memória)
// Guarda dados enquanto o usuário responde as perguntas do cartão
// ============================================================
const sessoes = new Map();

function salvarSessao(usuarioId, dados) {
  sessoes.set(String(usuarioId), { ...dados, timestamp: Date.now() });
}

function buscarSessao(usuarioId) {
  const sessao = sessoes.get(String(usuarioId));
  if (!sessao) return null;
  // Expira em 10 minutos
  if (Date.now() - sessao.timestamp > 10 * 60 * 1000) {
    sessoes.delete(String(usuarioId));
    return null;
  }
  return sessao;
}

function limparSessao(usuarioId) {
  sessoes.delete(String(usuarioId));
}

module.exports = {
  buscarCartoes,
  criarCartao,
  calcularDatasParcelas,
  salvarParcelasComCartao,
  salvarSessao,
  buscarSessao,
  limparSessao
};
