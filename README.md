# Steam Backlog Picker

Aplicação web local minimalista em Dark Mode para filtrar, organizar e sortear jogos do seu backlog a partir de `jogos_familia_steam.txt`.

## Estrutura do Projeto

- `fetch_games.py` — Parser do `.txt`, coleta de dados da Steam Store + HowLongToBeat e cache incremental em `data/games.json`
- `server.py` — Servidor FastAPI local servindo a API (`/api/games`) e o frontend
- `frontend/` — Interface web minimalista (`index.html`, `styles.css`, `app.js`)
- `data/games.json` — Banco local em JSON gerado pelo coletor
- `jogos_familia_steam.txt` — Lista de jogos da Família Steam

## Como configurar

No diretório do projeto, ative o ambiente virtual (ou crie se ainda não existir):

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Coleta de Dados (`fetch_games.py`)

Testar com os primeiros 25 ou 30 jogos:

```powershell
.\venv\Scripts\python.exe fetch_games.py --limit 25
```

Rodar para a lista completa (pula automaticamente o que já está em `data/games.json`):

```powershell
.\venv\Scripts\python.exe fetch_games.py
```

Tentar buscar novamente apenas jogos/campos que falharam ou ficaram sem dados:

```powershell
.\venv\Scripts\python.exe fetch_games.py --retry-missing
```

## Rodar a Interface Web

```powershell
.\venv\Scripts\python.exe server.py
```

Depois acesse `http://127.0.0.1:8000` no navegador.

## GitHub Pages

O workflow `.github/workflows/deploy-pages.yml` publica automaticamente a interface estática (`frontend/` + `data/games.json`) no GitHub Pages a cada `push` na branch `main`.

Para atualizar o site publicado após coletar mais jogos com `fetch_games.py`:

```powershell
git add data/games.json
git commit -m "Update games database"
git push
```
