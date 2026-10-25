UUID = berth@ronitjadhav
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA = schemas/org.gnome.shell.extensions.berth.gschema.xml

all: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas schemas

# Symlink the checkout so edits are picked up on the next shell restart.
install: all
	rm -rf $(INSTALL_DIR)
	mkdir -p $(dir $(INSTALL_DIR))
	ln -s $(CURDIR) $(INSTALL_DIR)

# Install a copy. The old install is removed first: `gnome-extensions install
# --force` over a symlink empties the checkout the link points to.
install-copy: pack
	rm -rf $(INSTALL_DIR)
	gnome-extensions install $(UUID).shell-extension.zip

uninstall:
	rm -rf $(INSTALL_DIR)

pack: all
	gnome-extensions pack --force \
		--schema=$(SCHEMA) \
		--extra-source=indicator.js \
		--extra-source=docker.js \
		--extra-source=icons \
		--extra-source=LICENSE \
		.

test:
	gjs -m tests/docker.test.js

lint:
	npx --yes eslint@10 .

.PHONY: all install install-copy uninstall pack test lint
