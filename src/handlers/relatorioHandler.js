// src/handlers/relatorioHandler.js
const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');

// ============================================================
// HELPERS
// ============================================================
function formatBRL(valor) {
  return `R$ ${parseFloat(valor).toFixed(2).replace('.', ',')}`;
}

function getDataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function nomeMes(data) {
  return data.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
}

// ============================================================
// GERAR PDF EM MEMÓRIA
// ============================================================
async function gerarPDF(usuario, dados) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { transacoes, parcelas, metas, gastosPorCategoria } = dados;
    const agora = getDataBrasilia();
    const mes = nomeMes(agora);

    const gastos = transacoes.filter(t => t.tipo === 'gasto');
    const receitas = transacoes.filter(t => t.tipo === 'receita');
    const totalGastos = gastos.reduce((a, t) => a + parseFloat(t.valor), 0);
    const totalReceitas = receitas.reduce((a, t) => a + parseFloat(t.valor), 0);
    const saldo = totalReceitas - totalGastos;

    // Cores
    const VERDE = '#22c55e';
    const VERMELHO = '#ef4444';
    const CINZA = '#6b7280';
    const ESCURO = '#111827';
    const CLARO = '#f9fafb';

    // ── CABEÇALHO ──
    doc.rect(0, 0, doc.page.width, 80).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
      .text('Duartly', 40, 22);
    doc.fontSize(10).font('Helvetica').fillColor('#94a3b8')
      .text('Sua lhama financeira pessoal', 40, 48);
    doc.fillColor('#4ade80').fontSize(11)
      .text(`Relatorio de ${mes}`, 40, 62);

    // Nome do usuario
    doc.fillColor('#ffffff').fontSize(10)
      .text(`Usuario: ${usuario.nome || 'usuario'}`, 350, 35, { align: 'right', width: 200 });

    doc.moveDown(3);

    // ── RESUMO FINANCEIRO ──
    doc.fillColor(ESCURO).fontSize(14).font('Helvetica-Bold')
      .text('Resumo Financeiro', 40, 100);

    doc.moveTo(40, 118).lineTo(555, 118).strokeColor('#e5e7eb').stroke();

    // Cards de stats
    const cards = [
      { label: 'Receitas', valor: totalReceitas, cor: VERDE },
      { label: 'Gastos', valor: totalGastos, cor: VERMELHO },
      { label: 'Saldo', valor: saldo, cor: saldo >= 0 ? VERDE : VERMELHO },
    ];

    let xCard = 40;
    cards.forEach(card => {
      doc.rect(xCard, 125, 158, 65).fillAndStroke('#f8fafc', '#e5e7eb');
      doc.fillColor(CINZA).fontSize(9).font('Helvetica')
        .text(card.label.toUpperCase(), xCard + 10, 133);
      doc.fillColor(card.cor).fontSize(16).font('Helvetica-Bold')
        .text(formatBRL(card.valor), xCard + 10, 150);
      doc.fillColor(CINZA).fontSize(8).font('Helvetica')
        .text(`${card.label === 'Gastos' ? gastos.length : receitas.length} lancamentos`, xCard + 10, 173);
      xCard += 170;
    });

    // ── GASTOS POR CATEGORIA ──
    doc.fillColor(ESCURO).fontSize(14).font('Helvetica-Bold')
      .text('Gastos por Categoria', 40, 210);
    doc.moveTo(40, 228).lineTo(555, 228).strokeColor('#e5e7eb').stroke();

    const categorias = Object.entries(gastosPorCategoria)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8);

    let ycat = 235;
    categorias.forEach(([nome, dados]) => {
      const pct = totalGastos > 0 ? (dados.total / totalGastos) * 100 : 0;
      const barraLargura = Math.max((pct / 100) * 300, 2);

      doc.fillColor(CINZA).fontSize(9).font('Helvetica')
        .text(`${dados.emoji || ''} ${nome}`, 40, ycat);
      doc.fillColor(CINZA).fontSize(9)
        .text(formatBRL(dados.total), 420, ycat, { width: 100, align: 'right' });
      doc.fillColor(CINZA).fontSize(8)
        .text(`${pct.toFixed(1)}%`, 350, ycat);

      // Barra
      doc.rect(40, ycat + 13, 300, 6).fillColor('#e5e7eb').fill();
      doc.rect(40, ycat + 13, barraLargura, 6).fillColor('#4ade80').fill();

      ycat += 30;
    });

    // ── TRANSAÇÕES ──
    const yTransacoes = ycat + 15;
    doc.fillColor(ESCURO).fontSize(14).font('Helvetica-Bold')
      .text('Ultimas Transacoes', 40, yTransacoes);
    doc.moveTo(40, yTransacoes + 18).lineTo(555, yTransacoes + 18).strokeColor('#e5e7eb').stroke();

    // Cabeçalho tabela
    let ytab = yTransacoes + 25;
    doc.fillColor(CINZA).fontSize(8).font('Helvetica-Bold')
      .text('DATA', 40, ytab)
      .text('DESCRICAO', 90, ytab)
      .text('CATEGORIA', 310, ytab)
      .text('VALOR', 460, ytab, { width: 80, align: 'right' });

    ytab += 15;
    doc.moveTo(40, ytab).lineTo(555, ytab).strokeColor('#e5e7eb').stroke();
    ytab += 5;

    transacoes.slice(0, 15).forEach((t, i) => {
      if (ytab > 750) {
        doc.addPage();
        ytab = 40;
      }

      if (i % 2 === 0) {
        doc.rect(40, ytab - 2, 515, 16).fillColor(CLARO).fill();
      }

      const data = t.data_transacao ? t.data_transacao.split('-').reverse().join('/') : '';
      const cor = t.tipo === 'receita' ? VERDE : ESCURO;

      doc.fillColor(CINZA).fontSize(8).font('Helvetica')
        .text(data, 40, ytab, { width: 45 });
      doc.fillColor(ESCURO)
        .text(t.descricao?.substring(0, 30) || '', 90, ytab, { width: 215 });
      doc.fillColor(CINZA)
        .text(t.categorias?.nome || 'Outros', 310, ytab, { width: 140 });
      doc.fillColor(cor).font('Helvetica-Bold')
        .text(`${t.tipo === 'receita' ? '+' : '-'}${formatBRL(t.valor)}`, 460, ytab, { width: 80, align: 'right' });

      ytab += 16;
    });

    // ── PARCELAS ATIVAS ──
    if (parcelas && parcelas.length > 0) {
      if (ytab > 680) { doc.addPage(); ytab = 40; }

      ytab += 15;
      doc.fillColor(ESCURO).fontSize(14).font('Helvetica-Bold')
        .text('Parcelas Ativas', 40, ytab);
      doc.moveTo(40, ytab + 18).lineTo(555, ytab + 18).strokeColor('#e5e7eb').stroke();
      ytab += 28;

      parcelas.slice(0, 8).forEach(p => {
        if (ytab > 750) { doc.addPage(); ytab = 40; }
        const venc = p.data_transacao ? p.data_transacao.split('-').reverse().join('/') : '';
        doc.fillColor(ESCURO).fontSize(9).font('Helvetica')
          .text(p.descricao?.substring(0, 40) || '', 40, ytab);
        doc.fillColor('#f59e0b').font('Helvetica-Bold')
          .text(formatBRL(p.valor), 460, ytab, { width: 80, align: 'right' });
        doc.fillColor(CINZA).fontSize(8).font('Helvetica')
          .text(`Vence: ${venc}`, 40, ytab + 11);
        ytab += 28;
      });
    }

    // ── METAS ──
    if (metas && metas.length > 0) {
      if (ytab > 650) { doc.addPage(); ytab = 40; }

      ytab += 15;
      doc.fillColor(ESCURO).fontSize(14).font('Helvetica-Bold')
        .text('Metas do Mes', 40, ytab);
      doc.moveTo(40, ytab + 18).lineTo(555, ytab + 18).strokeColor('#e5e7eb').stroke();
      ytab += 28;

      metas.forEach(meta => {
        if (ytab > 750) { doc.addPage(); ytab = 40; }
        const gasto = gastosPorCategoria[meta.categoria_id]?.total || 0;
        const limite = parseFloat(meta.valor_limite);
        const pct = Math.min(Math.round((gasto / limite) * 100), 100);
        const corMeta = pct >= 100 ? VERMELHO : pct >= 80 ? '#f59e0b' : VERDE;
        const barraLarg = Math.max((pct / 100) * 300, 2);

        doc.fillColor(ESCURO).fontSize(9).font('Helvetica')
          .text(`${meta.categorias?.emoji || ''} ${meta.categorias?.nome || ''}`, 40, ytab);
        doc.fillColor(corMeta).font('Helvetica-Bold')
          .text(`${pct}%`, 350, ytab);
        doc.fillColor(CINZA).font('Helvetica')
          .text(`${formatBRL(gasto)} / ${formatBRL(limite)}`, 400, ytab, { width: 140, align: 'right' });

        doc.rect(40, ytab + 13, 300, 6).fillColor('#e5e7eb').fill();
        doc.rect(40, ytab + 13, barraLarg, 6).fillColor(corMeta).fill();

        ytab += 30;
      });
    }

    // ── RODAPÉ ──
    const yRodape = doc.page.height - 40;
    doc.moveTo(40, yRodape - 10).lineTo(555, yRodape - 10).strokeColor('#e5e7eb').stroke();
    doc.fillColor(CINZA).fontSize(8).font('Helvetica')
      .text(`Duartly · Sua lhama financeira pessoal · Gerado em ${new Date().toLocaleDateString('pt-BR')}`,
        40, yRodape, { align: 'center', width: 515 });

    doc.end();
  });
}

// ============================================================
// /relatorio — Handler principal
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

    // Buscar dados
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

    // Agrupar gastos por categoria
    const gastosPorCategoria = {};
    transacoes?.filter(t => t.tipo === 'gasto').forEach(t => {
      const cat = t.categorias?.nome || 'Outros';
      const emoji = t.categorias?.emoji || '📌';
      const catId = t.categoria_id;
      if (!gastosPorCategoria[cat]) gastosPorCategoria[cat] = { total: 0, emoji, catId };
      gastosPorCategoria[cat].total += parseFloat(t.valor);
    });

    // Gerar PDF
    const pdfBuffer = await gerarPDF(ctx.usuario, {
      transacoes: transacoes || [],
      parcelas: parcelas || [],
      metas: metas || [],
      gastosPorCategoria
    });

    // Deletar mensagem de "gerando..."
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);

    // Enviar PDF
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
