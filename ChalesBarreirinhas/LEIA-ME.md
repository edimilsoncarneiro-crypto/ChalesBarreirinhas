# Chalés Barreirinhas

## Iniciar o sistema

1. Instale o Node.js 22 ou mais recente.
2. Execute `iniciar.bat`. Na primeira execução, o arquivo instala as dependências se ainda não estiverem presentes.
3. Mantenha a janela do servidor aberta e acesse <http://localhost:3000>.

Use o endereço acima em cada navegador deste computador. Não abra `index.html` diretamente para usar o sistema: é o servidor que conecta a página ao banco.

## Login e senha

Na primeira inicializacao, o terminal do servidor mostra um codigo de configuracao. Informe esse codigo na tela que abrir, escolha um login de 3 a 32 caracteres e crie uma senha com pelo menos 12 caracteres. O codigo so pode ser usado uma vez.

O login protege a pagina e as rotas da API. A senha e armazenada como hash no arquivo `data/auth_config.json`; a sessao expira apos 8 horas e o botao **Sair** encerra o acesso naquele navegador. Todos os usuarios compartilham o mesmo login.

Para redefinir o login, pare o servidor e apague somente `data/auth_config.json`. Ao iniciar novamente, um novo codigo de configuracao sera mostrado. Isso preserva `data/database.sqlite` e os registros.

O login nao substitui HTTPS. Use a aplicacao apenas em uma rede privada confiavel enquanto estiver servida por HTTP; nao encaminhe a porta 3000 para a internet sem configurar HTTPS.

## Onde os dados ficam

Despesas e aportes são gravados em `data/database.sqlite`. Navegadores diferentes neste computador consultam o mesmo banco enquanto o servidor estiver ativo.

Para acessar a partir de outro computador na mesma rede, use o endereço IPv4 do computador que está executando o servidor, seguido de `:3000` (por exemplo, `http://192.168.0.10:3000`). O servidor precisa continuar ligado e o Firewall do Windows pode pedir autorização para a rede privada. Isso não publica o sistema na internet.

## Cópias de segurança

Use **Exportar dados em JSON** com o servidor conectado. O sistema baixa um arquivo e também grava cópias na pasta `backups`. Guarde uma cópia em outro local, pois uma falha no computador pode afetar tanto o banco quanto os arquivos que estão apenas nele.

Se você usava uma versão anterior que guardava dados no navegador, abra o sistema uma vez no navegador antigo enquanto o servidor estiver ligado. A página tenta migrar esses registros para o SQLite e mantém uma cópia local de segurança da migração.
