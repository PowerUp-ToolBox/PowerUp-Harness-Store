import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import type { Catalog } from '../../src/shared/i18n/catalogs.js';

/**
 * The catalog parity check run in CI (through catalogs.test.ts): `other` must have exactly the
 * keys of `en`, every message of both must be valid ICU, and each `other` message must use the
 * same argument names as its en message. Returns one line per problem, naming the key.
 */
export function compareCatalogs(en: Catalog, other: Catalog, otherName: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(en)) {
    if (!Object.hasOwn(other, key)) problems.push(`${otherName}.json is missing the key "${key}"`);
  }
  for (const key of Object.keys(other)) {
    if (!Object.hasOwn(en, key)) {
      problems.push(`${otherName}.json has the key "${key}", which en.json does not`);
    }
  }
  for (const [key, message] of Object.entries(en)) {
    const enArguments = argumentsOf(message);
    if (typeof enArguments === 'string') {
      problems.push(`en.json "${key}" is not valid ICU: ${enArguments}`);
      continue;
    }
    if (!Object.hasOwn(other, key)) continue;
    const otherArguments = argumentsOf(other[key] ?? '');
    if (typeof otherArguments === 'string') {
      problems.push(`${otherName}.json "${key}" is not valid ICU: ${otherArguments}`);
    } else if (otherArguments.join() !== enArguments.join()) {
      problems.push(
        `${otherName}.json "${key}" uses the arguments [${otherArguments.join(', ')}], ` +
          `but en.json uses [${enArguments.join(', ')}]`,
      );
    }
  }
  return problems;
}

/** The sorted argument names of an ICU message, or the parse error's text. */
export function argumentsOf(message: string): string[] | string {
  let elements: MessageFormatElement[];
  try {
    elements = parse(message);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const names = new Set<string>();
  collect(elements, names);
  return [...names].sort();
}

function collect(elements: readonly MessageFormatElement[], names: Set<string>): void {
  for (const element of elements) {
    if (isTagElement(element)) {
      names.add(`<${element.value}>`);
      collect(element.children, names);
    } else if (isSelectElement(element) || isPluralElement(element)) {
      names.add(element.value);
      for (const option of Object.values(element.options)) collect(option.value, names);
    } else if (
      isArgumentElement(element) ||
      isNumberElement(element) ||
      isDateElement(element) ||
      isTimeElement(element)
    ) {
      names.add(element.value);
    }
  }
}
