/** Нарушение доменного правила: неверный ввод или недопустимый переход состояния. */
export class DomainError extends Error {
  override name = 'DomainError';
}
