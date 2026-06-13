// src/handlers/relatorioHandler.js
const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');

function formatBRL(valor) {
  return `R$ ${parseFloat(valor).toFixed(2).replace('.', ',')}`;
}

function getDataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

// Remove emojis e caracteres especiais, mantendo texto limpo
function limparTexto(texto) {
  if (!texto) return '';
  return texto.replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
              .replace(/[\u{2600}-\u{26FF}]/gu, '')
              .replace(/[\u{2700}-\u{27BF}]/gu, '')
              .replace(/[^\x00-\x7F\u00C0-\u024F]/g, '')
              .trim();
}

// Mapeia categoria para abreviação limpa
function labelCategoria(nome) {
  const mapa = {
    'Alimentacao': '[Alimentacao]',
    'Alimentação': '[Alimentacao]',
    'Transporte':  '[Transporte]',
    'Moradia':     '[Moradia]',
    'Saude':       '[Saude]',
    'Saúde':       '[Saude]',
    'Lazer':       '[Lazer]',
    'Educacao':    '[Educacao]',
    'Educação':    '[Educacao]',
    'Vestuario':   '[Vestuario]',
    'Vestuário':   '[Vestuario]',
    'Mercado':     '[Mercado]',
    'Delivery':    '[Delivery]',
    'Assinaturas': '[Assinat.]',
    'Investimentos':'[Invest.]',
    'Receita':     '[Receita]',
    'Outros':      '[Outros]',
  };
  return mapa[nome] || `[${limparTexto(nome).substring(0, 10)}]`;
}

async function gerarPDF(usuario, dados) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { transacoes, parcelas, metas, gastosPorCategoria } = dados;
    const agora = getDataBrasilia();
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const nomeMes = agora.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

    const gastos = transacoes.filter(t => t.tipo === 'gasto');
    const receitas = transacoes.filter(t => t.tipo === 'receita');
    const totalGastos = gastos.reduce((a, t) => a + parseFloat(t.valor), 0);
    const totalReceitas = receitas.reduce((a, t) => a + parseFloat(t.valor), 0);
    const saldo = totalReceitas - totalGastos;

    const VERDE   = '#22c55e';
    const VERMELHO = '#ef4444';
    const CINZA   = '#6b7280';
    const ESCURO  = '#111827';
    const CLARO   = '#f9fafb';
    const AMARELO = '#f59e0b';
    const W = doc.page.width - 80; // largura útil

    // ── CABEÇALHO ──
    doc.rect(0, 0, doc.page.width, 70).fill('#0f172a');

    // Lhama ASCII art simplificada
    doc.fillColor('#4ade80').fontSize(18).font('Helvetica-Bold')
      .text('Duartly', 40, 18);
    doc.fillColor('#94a3b8').fontSize(9).font('Helvetica')
      .text('Sua lhama financeira pessoal', 40, 40)
      .text(`Relatorio de ${nomeMes}`, 40, 53);
    doc.fillColor('#ffffff').fontSize(9)
      .text(`Usuario: ${limparTexto(usuario.nome || 'usuario')}`, 40, 18, { align: 'right', width: W + 40 });
    doc.fillColor('#94a3b8').fontSize(8)
      .text(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`, 40, 30, { align: 'right', width: W + 40 });

    let y = 85;

    // ── RESUMO FINANCEIRO ──
    doc.fillColor(ESCURO).fontSize(11).font('Helvetica-Bold').text('RESUMO FINANCEIRO', 40, y);
    doc.moveTo(40, y + 14).lineTo(555, y + 14).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    y += 20;

    const cardW = (W / 3) - 6;
    const cards = [
      { label: 'RECEITAS', valor: totalReceitas, cor: VERDE, qtd: receitas.length },
      { label: 'GASTOS',   valor: totalGastos,   cor: VERMELHO, qtd: gastos.length },
      { label: 'SALDO',    valor: saldo,          cor: saldo >= 0 ? VERDE : VERMELHO, qtd: null },
    ];

    cards.forEach((card, i) => {
      const xc = 40 + i * (cardW + 9);
      doc.rect(xc, y, cardW, 52).fillAndStroke('#f8fafc', '#e5e7eb');
      doc.fillColor(CINZA).fontSize(7).font('Helvetica-Bold').text(card.label, xc + 8, y + 8);
      doc.fillColor(card.cor).fontSize(14).font('Helvetica-Bold').text(formatBRL(card.valor), xc + 8, y + 20);
      if (card.qtd !== null) {
        doc.fillColor(CINZA).fontSize(7).font('Helvetica').text(`${card.qtd} lancamento(s)`, xc + 8, y + 40);
      }
    });
    y += 65;

    // ── GASTOS POR CATEGORIA ──
    doc.fillColor(ESCURO).fontSize(11).font('Helvetica-Bold').text('GASTOS POR CATEGORIA', 40, y);
    doc.moveTo(40, y + 14).lineTo(555, y + 14).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    y += 20;

    const cats = Object.entries(gastosPorCategoria)
      .sort((a, b) => b[1].total - a[1].total).slice(0, 6);

    cats.forEach(([nome, dados]) => {
      const pct = totalGastos > 0 ? (dados.total / totalGastos) * 100 : 0;
      const barW = Math.max((pct / 100) * 220, 2);
      const label = labelCategoria(nome);

      doc.fillColor(ESCURO).fontSize(8).font('Helvetica').text(label, 40, y, { width: 90 });
      doc.rect(135, y + 1, 220, 7).fillColor('#e5e7eb').fill();
      doc.rect(135, y + 1, barW, 7).fillColor('#4ade80').fill();
      doc.fillColor(CINZA).fontSize(8).text(`${pct.toFixed(1)}%`, 362, y, { width: 40, align: 'right' });
      doc.fillColor(ESCURO).font('Helvetica-Bold').text(formatBRL(dados.total), 410, y, { width: 100, align: 'right' });
      y += 16;
    });
    y += 8;

    // ── TRANSAÇÕES ──
    doc.fillColor(ESCURO).fontSize(11).font('Helvetica-Bold').text('TRANSACOES DO MES', 40, y);
    doc.moveTo(40, y + 14).lineTo(555, y + 14).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    y += 20;

    // Cabeçalho
    doc.fillColor(CINZA).fontSize(7).font('Helvetica-Bold')
      .text('DATA', 40, y)
      .text('DESCRICAO', 90, y)
      .text('CATEGORIA', 310, y)
      .text('VALOR', 460, y, { width: 80, align: 'right' });
    y += 12;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
    y += 4;

    transacoes.slice(0, 18).forEach((t, i) => {
      if (y > 760) { doc.addPage(); y = 40; }

      if (i % 2 === 0) doc.rect(40, y - 1, W + 40, 13).fillColor(CLARO).fill();

      const data = t.data_transacao ? t.data_transacao.split('-').reverse().join('/') : '';
      const desc = limparTexto(t.descricao || '').substring(0, 28);
      const catNome = limparTexto(t.categorias?.nome || 'Outros');
      const cor = t.tipo === 'receita' ? VERDE : ESCURO;

      doc.fillColor(CINZA).fontSize(7.5).font('Helvetica').text(data, 40, y, { width: 45 });
      doc.fillColor(ESCURO).text(desc, 90, y, { width: 215 });
      doc.fillColor(CINZA).text(labelCategoria(catNome), 310, y, { width: 140 });
      doc.fillColor(cor).font('Helvetica-Bold')
        .text(`${t.tipo === 'receita' ? '+' : '-'}${formatBRL(t.valor)}`, 460, y, { width: 80, align: 'right' });
      y += 13;
    });
    y += 8;

    // ── PARCELAS + METAS na mesma área ──
    const temParcelas = parcelas && parcelas.length > 0;
    const temMetas = metas && metas.length > 0;

    if (temParcelas || temMetas) {
      if (y > 650) { doc.addPage(); y = 40; }

      // Duas colunas lado a lado
      const col1X = 40;
      const col2X = 300;
      const colW = 240;
      let y1 = y;
      let y2 = y;

      // COLUNA 1: Parcelas
      if (temParcelas) {
        doc.fillColor(ESCURO).fontSize(11).font('Helvetica-Bold').text('PARCELAS ATIVAS', col1X, y1);
        doc.moveTo(col1X, y1 + 14).lineTo(col1X + colW, y1 + 14).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y1 += 20;

        // Agrupar por grupo_parcela
        const grupos = {};
        parcelas.forEach(p => {
          const g = p.grupo_parcela || p.id;
          if (!grupos[g]) grupos[g] = [];
          grupos[g].push(p);
        });

        Object.values(grupos).slice(0, 6).forEach(grupo => {
          if (y1 > 760) return;
          const primeira = grupo[0];
          const nome = limparTexto(primeira.descricao || '').replace(/\s*\(\d+\/\d+\)/, '').substring(0, 20);
          const valorParcela = parseFloat(primeira.valor);
          const restantes = grupo.length;
          const venc = primeira.data_transacao ? primeira.data_transacao.split('-').reverse().join('/') : '';

          doc.fillColor(ESCURO).fontSize(8).font('Helvetica-Bold').text(nome, col1X, y1, { width: colW });
          doc.fillColor(AMARELO).font('Helvetica').text(formatBRL(valorParcela), col1X + 150, y1, { width: 90, align: 'right' });
          doc.fillColor(CINZA).fontSize(7).text(`${restantes}x restante(s) · Prox: ${venc}`, col1X, y1 + 10, { width: colW });
          y1 += 24;
        });
      }

      // COLUNA 2: Metas
      if (temMetas) {
        doc.fillColor(ESCURO).fontSize(11).font('Helvetica-Bold').text('METAS DO MES', col2X, y2);
        doc.moveTo(col2X, y2 + 14).lineTo(col2X + colW, y2 + 14).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y2 += 20;

        metas.slice(0, 6).forEach(meta => {
          if (y2 > 760) return;
          const gasto = gastosPorCategoria[meta.categoria_id]?.total || 0;
          const limite = parseFloat(meta.valor_limite);
          const pct = Math.min(Math.round((gasto / limite) * 100), 100);
          const corMeta = pct >= 100 ? VERMELHO : pct >= 80 ? AMARELO : VERDE;
          const barW = Math.max((pct / 100) * 180, 2);
          const catNome = limparTexto(meta.categorias?.nome || '');

          doc.fillColor(ESCURO).fontSize(8).font('Helvetica-Bold')
            .text(labelCategoria(catNome), col2X, y2, { width: 120 });
          doc.fillColor(corMeta).font('Helvetica')
            .text(`${pct}%`, col2X + 120, y2, { width: 40, align: 'right' });
          doc.fillColor(CINZA).fontSize(7)
            .text(`${formatBRL(gasto)} / ${formatBRL(limite)}`, col2X + 165, y2, { width: 75, align: 'right' });

          doc.rect(col2X, y2 + 11, 180, 5).fillColor('#e5e7eb').fill();
          doc.rect(col2X, y2 + 11, barW, 5).fillColor(corMeta).fill();
          y2 += 22;
        });
      }

      y = Math.max(y1, y2) + 10;
    }

    // ── RODAPÉ ──
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.rect(0, doc.page.height - 28, doc.page.width, 28).fill('#0f172a');
      doc.fillColor('#94a3b8').fontSize(7).font('Helvetica')
        .text(
          `Duartly - Sua lhama financeira pessoal | Pagina ${i + 1} de ${pageCount}`,
          40, doc.page.height - 18,
          { align: 'center', width: W + 40 }
        );
    }

    doc.end();
  });
}

// ============================================================
// HANDLER
// ============================================================
async function handleRelatorio(ctx) {
  const usuarioId = ctx.usuario.id;
  const msg = await ctx.reply('🦙 Gerando seu relatorio PDF...');

  try {
    const agora = getDataBrasilia();
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const fimMes = new Date(ano, mes, 0).toISOString().split('T')[0];
    const hoje = agora.toISOString().split('T')[0];

    const [
      { data: transacoes },
      { data: parcelas },
      { data: metas }
    ] = await Promise.all([
      supabase.from('transacoes').select('*, categorias(nome, emoji)')
        .eq('usuario_id', usuarioId).eq('cancelado', false)
        .gte('data_transacao', inicioMes).lte('data_transacao', fimMes)
        .order('data_transacao', { ascending: false }),
      supabase.from('transacoes').select('*, categorias(nome, emoji)')
        .eq('usuario_id', usuarioId).eq('cancelado', false).eq('parcelado', true)
        .gte('data_transacao', hoje).order('data_transacao', { ascending: true }),
      supabase.from('metas').select('*, categorias(nome, emoji)')
        .eq('usuario_id', usuarioId).eq('mes', mes).eq('ano', ano)
    ]);

    const gastosPorCategoria = {};
    transacoes?.filter(t => t.tipo === 'gasto').forEach(t => {
      const cat = t.categorias?.nome || 'Outros';
      const catId = t.categoria_id;
      if (!gastosPorCategoria[cat]) gastosPorCategoria[cat] = { total: 0, emoji: '', catId };
      gastosPorCategoria[cat].total += parseFloat(t.valor);
    });

    const pdfBuffer = await gerarPDF(ctx.usuario, {
      transacoes: transacoes || [],
      parcelas: parcelas || [],
      metas: metas || [],
      gastosPorCategoria
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);

    const nomeArquivo = `duartly-${String(mes).padStart(2,'0')}-${ano}.pdf`;
    await ctx.replyWithDocument(
      { source: pdfBuffer, filename: nomeArquivo },
      { caption: `🦙 Relatorio de ${agora.toLocaleString('pt-BR', { month: 'long', year: 'numeric' })} pronto!` }
    );

  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      '🦙 Erro ao gerar o relatorio. Tenta de novo!'
    );
  }
}

module.exports = { handleRelatorio };
