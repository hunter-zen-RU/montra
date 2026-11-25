import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**']
  },
  {
    files: ['DRAFT_firestore.rules', 'firestore.rules'],
    ...firebaseRulesPlugin.configs['flat/recommended']
  }
];
