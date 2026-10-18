export const USER_INPUT_METHODS = ['item/tool/requestUserInput', 'tool/requestUserInput'];

export function createUserInputCard(request, { t, respond, onResolved, onError, draft = {} }) {
  const card = document.createElement('section');
  card.className = 'user-input-card';
  card.dataset.requestId = String(request.id);
  card.dataset.i18nIgnore = '';
  const form = document.createElement('form');
  const heading = document.createElement('strong');
  heading.className = 'user-input-title';
  heading.textContent = t('Waiting for your answer');
  form.append(heading);
  const fields = [];
  for (const [index, question] of (request.params?.questions || []).entries()) {
    const fieldset = document.createElement('fieldset');
    fieldset.dataset.questionId = question.id;
    const legend = document.createElement('legend');
    legend.textContent = question.header || `${index + 1}`;
    const prompt = document.createElement('p');
    prompt.className = 'user-input-question';
    prompt.textContent = question.question;
    fieldset.append(legend, prompt);
    const saved = draft[question.id] || (draft[question.id] = { selected: '', text: '' });
    const radios = [];
    const options = question.options || [];
    const customAllowed = !options.length || question.isOther === true;
    let custom;
    const update = () => {
      for (const radio of radios) radio.closest('label').classList.toggle('selected', radio.checked);
      if (custom) {
        custom.hidden = options.length > 0 && saved.selected !== 'custom';
        custom.required = !custom.hidden;
        custom.disabled = custom.hidden;
      }
    };
    function addOption(label, description, value) {
      const option = document.createElement('label');
      option.className = 'user-input-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `question-${request.id}-${index}`;
      radio.value = value;
      radio.required = true;
      radio.checked = saved.selected === value;
      radio.onchange = () => { saved.selected = value; update(); if (value === 'custom') custom?.focus(); };
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = label;
      copy.append(title);
      if (description) {
        const detail = document.createElement('small');
        detail.textContent = description;
        copy.append(detail);
      }
      option.append(radio, copy);
      fieldset.append(option);
      radios.push(radio);
    }
    options.forEach((option, optionIndex) => addOption(option.label, option.description, String(optionIndex)));
    if (options.length && customAllowed) addOption(t('Write your own answer'), '', 'custom');
    if (customAllowed) {
      custom = document.createElement(question.isSecret ? 'input' : 'textarea');
      if (question.isSecret) { custom.type = 'password'; custom.autocomplete = 'off'; }
      else custom.rows = 2;
      custom.className = 'user-input-custom';
      custom.setAttribute('aria-label', question.question);
      custom.placeholder = t('Write your answer…');
      custom.value = saved.text;
      custom.oninput = () => { saved.text = custom.value; };
      fieldset.append(custom);
    }
    fields.push({ question, saved, custom, fieldset });
    update();
    form.append(fieldset);
  }
  const error = document.createElement('p');
  error.className = 'user-input-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'user-input-submit';
  submit.textContent = t('Submit answer');
  form.append(error, submit);
  card.append(form);
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    const answers = Object.create(null);
    for (const { question, saved, custom } of fields) {
      const answer = (!question.options?.length || saved.selected === 'custom')
        ? custom.value.trim() : question.options[Number(saved.selected)]?.label;
      if (!answer) { custom?.focus(); return; }
      answers[question.id] = { answers: [answer] };
    }
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = t('Submitting…');
    for (const { fieldset } of fields) fieldset.disabled = true;
    try {
      await respond(request.id, { answers });
      onResolved(request.id);
    } catch (failure) {
      if (!card.isConnected) return;
      error.textContent = failure.message || t('Could not submit answer');
      error.hidden = false;
      onError(error.textContent);
      submit.disabled = false;
      submit.textContent = t('Submit answer');
      for (const { fieldset } of fields) fieldset.disabled = false;
    }
  };
  return card;
}
