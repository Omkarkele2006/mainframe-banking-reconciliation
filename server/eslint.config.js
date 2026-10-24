import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['dist'] }, js.configs.recommended, ...tseslint.configs.recommended, { files: ['**/*.ts'], languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', __dirname: 'readonly' } } });
