const modeloClassificacao = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.1,
  }
});

const modeloConversa = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash',
  generationConfig: {
    temperature: 0.7,
  }
});
