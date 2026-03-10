from cyclopts import App
from dotenv import load_dotenv

from dazense_core import __version__
from dazense_core.commands import chat, debug, eval, init, sync, test, upgrade, validate
from dazense_core.version import check_for_updates

load_dotenv()

app = App(version=__version__)

app.command(chat)
app.command(debug)
app.command(init)
app.command(sync)
app.command(test)
app.command(upgrade)
app.command(validate)
app.command(eval)


def main():
    check_for_updates()
    app()


if __name__ == "__main__":
    main()
