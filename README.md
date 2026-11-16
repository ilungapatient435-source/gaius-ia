# Gaius IA

Assistant conversationnel en français propulsé par Gemini (`server.ts` + React/Vite) avec prise en charge complète du Web et de l’APK Android à partir du même code source.

## Démarrage Web (serveur Express + React/Vite)

1. Installer les dépendances :
   ```bash
   npm install
   ```
2. Configurer les variables d’environnement et les secrets dans le panneau **Secrets** d’AI Studio (ne jamais placer de secrets en clair dans `.env.example` ni dans le code).
3. Lancer en développement ou en production :
   ```bash
   # Développement (Express + Vite middleware)
   npm run dev

   # Production
   npm run build
   npm start
   ```

## Configuration des variables d’environnement

### Réglages publics (`.env.example` / environnement)
- `APP_SERVER_URL` : URL publique du serveur utilisée par l’APK Android (doit être définie avant la compilation de l’APK ; sinon l’application affiche « Adresse du serveur non configurée »).
- `APP_URL` : URL publique du serveur Web (utilisée pour les liens OAuth Google si derrière un proxy).
- `DATA_DIR` : dossier persistant de stockage des comptes (`DATA_DIR/accounts.json`) et des historiques (`DATA_DIR/conversations/<identifiant>.json`). Par défaut `./data`.
- `DAILY_REQUEST_LIMIT` : limite quotidienne de requêtes IA par compte (défaut `120`).
- `MAX_CONVERSATIONS_PER_USER` : nombre maximal de conversations enregistrées par utilisateur (défaut `500`).
- `ADMIN_PATH` : route cachée de l’espace de gestion (défaut `/gaius-gestion`).
- `ADMIN_NOTIFY_EMAIL` : adresse recevant une alerte e-mail à chaque nouvelle inscription (défaut `ndalagaius3@gmail.com`).
- `MAIL_FROM` : expéditeur affiché des e-mails de vérification.

### Secrets (panneau Secrets d’AI Studio uniquement)
- `GEMINI_API_KEY` : clé API Google Gemini.
- `SESSION_SECRET` : clé HMAC de signature des jetons de session.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` : identifiants de l’espace de gestion caché.
- `GMAIL_USER` / `GMAIL_APP_PASSWORD` : identifiants Gmail SMTP (SSL port `465`, mot de passe d’application Google à 16 caractères).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` : identifiants Google OAuth 2.0 (optionnels ; si absents, le bouton Google reste désactivé avec « bientôt disponible »).
  - URI de redirection autorisée à déclarer dans Google Cloud Console : `<URL_SERVEUR>/api/auth/google/callback`

## Build Android APK

Le module `app/` embarque directement le build Vite (`app/src/main/assets/www/`) dans un conteneur Android WebView avec :
- Injection de `APP_SERVER_URL` au moment du build (`BuildConfig.APP_SERVER_URL`) ;
- Authentification par jeton Bearer + WebSocket vocal Live sécurisé ;
- Retour Google OAuth via navigateur externe et lien profond `gaiusia://auth/callback` ;
- Sélecteur de fichiers, permission microphone `RECORD_AUDIO` et téléchargement de fichiers dans `Téléchargements`.

Après toute modification du frontend React :
```bash
npm run build
rm -rf app/src/main/assets/www && mkdir -p app/src/main/assets/www && cp -r dist/* app/src/main/assets/www/ && rm -rf app/src/main/assets/www/assets/aistudio
gradle assembleDebug
```
