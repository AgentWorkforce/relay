/**
 * The prompts `relay init` asks in a terminal, behind a small interface so the
 * guided flow can be driven by a script in tests. The real implementation is
 * @clack/prompts, the library `npx skills add` uses, so the two look alike.
 */

import * as clack from '@clack/prompts';

/** Returned by a prompt the person cancelled (Ctrl+C or Escape). */
export const CANCELLED = Symbol('cancelled');
export type Answer<T> = T | typeof CANCELLED;

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

/** Everything the guided flow shows or asks. */
export interface InitPrompter {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  select<T>(input: { message: string; options: Choice<T>[]; initialValue?: T }): Promise<Answer<T>>;
  multiselect<T>(input: { message: string; options: Choice<T>[]; initialValues?: T[] }): Promise<Answer<T[]>>;
  text(input: {
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<Answer<string>>;
  password(input: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<Answer<string>>;
  confirm(input: { message: string; initialValue?: boolean }): Promise<Answer<boolean>>;
  spinner(): Spinner;
}

function answer<T>(value: unknown): Answer<T> {
  return clack.isCancel(value) ? CANCELLED : (value as T);
}

/** The terminal prompter, built on @clack/prompts. */
export function clackPrompter(): InitPrompter {
  return {
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    cancel: (message) => clack.cancel(message),
    note: (message, title) => clack.note(message, title),
    info: (message) => clack.log.info(message),
    warn: (message) => clack.log.warn(message),
    success: (message) => clack.log.success(message),
    select: async <T>(input: { message: string; options: Choice<T>[]; initialValue?: T }) =>
      answer<T>(
        await clack.select({
          message: input.message,
          options: input.options as never,
          initialValue: input.initialValue,
        })
      ),
    multiselect: async <T>(input: { message: string; options: Choice<T>[]; initialValues?: T[] }) =>
      answer<T[]>(
        await clack.multiselect({
          message: input.message,
          options: input.options as never,
          initialValues: input.initialValues,
          required: false,
        })
      ),
    text: async (input) =>
      answer<string>(
        await clack.text({
          message: input.message,
          placeholder: input.placeholder,
          validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
        })
      ),
    password: async (input) =>
      answer<string>(
        await clack.password({
          message: input.message,
          validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
        })
      ),
    confirm: async (input) => answer<boolean>(await clack.confirm(input)),
    spinner: () => {
      const s = clack.spinner();
      return {
        start: (message) => s.start(message),
        message: (message) => s.message(message),
        stop: (message) => s.stop(message),
        error: (message) => s.error(message),
      };
    },
  };
}
