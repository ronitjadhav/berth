export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                global: 'readonly',
                console: 'readonly',
                print: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': 'error',
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'no-template-curly-in-string': 'off',
        },
    },
];
