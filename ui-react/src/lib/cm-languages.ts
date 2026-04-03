import { StreamLanguage } from '@codemirror/language';
import { vb } from '@codemirror/legacy-modes/mode/vb';
import { javascript } from '@codemirror/lang-javascript';
import { sql, PostgreSQL } from '@codemirror/lang-sql';

export const vbaLanguage = StreamLanguage.define(vb);
export { javascript };
export const typescriptLanguage = () => javascript({ typescript: true });
export const postgresSQL = () => sql({ dialect: PostgreSQL });
