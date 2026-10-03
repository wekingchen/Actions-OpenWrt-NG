// SPDX-License-Identifier: MIT
/*
 * Read-only Kconfig exporter for OpenWrt NG Config Studio.
 *
 * It links against the exact OpenWrt scripts/config parser objects so the
 * browser catalog follows OpenWrt's own Kconfig extensions and visibility
 * rules instead of attempting to reimplement them.
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lkc.h"

static void json_string(const char *value)
{
	const unsigned char *p = (const unsigned char *)(value ? value : "");

	putchar('"');
	for (; *p; p++) {
		switch (*p) {
		case '"':
			fputs("\\\"", stdout);
			break;
		case '\\':
			fputs("\\\\", stdout);
			break;
		case '\b':
			fputs("\\b", stdout);
			break;
		case '\f':
			fputs("\\f", stdout);
			break;
		case '\n':
			fputs("\\n", stdout);
			break;
		case '\r':
			fputs("\\r", stdout);
			break;
		case '\t':
			fputs("\\t", stdout);
			break;
		default:
			if (*p < 0x20)
				printf("\\u%04x", *p);
			else
				putchar(*p);
		}
	}
	putchar('"');
}

static bool excluded_symbol(const char *name)
{
	static const char *prefixes[] = {
		"PACKAGE_",
		"TARGET_",
		"DEFAULT_",
		"MODULE_DEFAULT_",
		NULL,
	};
	int i;

	if (!name || !*name)
		return true;

	for (i = 0; prefixes[i]; i++) {
		size_t len = strlen(prefixes[i]);
		if (!strncmp(name, prefixes[i], len))
			return true;
	}

	return false;
}

static void print_menu_path(struct menu *menu)
{
	struct menu *parents[32];
	struct menu *parent;
	int count = 0;
	int i;
	bool first = true;

	for (parent = menu->parent;
	     parent && parent != &rootmenu && count < 32;
	     parent = parent->parent) {
		const char *prompt = menu_get_prompt(parent);
		if (!prompt || !*prompt)
			continue;
		parents[count++] = parent;
	}

	putchar('[');
	for (i = count - 1; i >= 0; i--) {
		const char *prompt = menu_get_prompt(parents[i]);
		if (!first)
			putchar(',');
		json_string(prompt);
		first = false;
	}
	putchar(']');
}

static void print_assignable(struct symbol *sym)
{
	bool first = true;

	putchar('[');
	if (sym->type == S_BOOLEAN || sym->type == S_TRISTATE) {
		if (sym_tristate_within_range(sym, no)) {
			json_string("n");
			first = false;
		}
		if (sym_tristate_within_range(sym, mod)) {
			if (!first)
				putchar(',');
			json_string("m");
			first = false;
		}
		if (sym_tristate_within_range(sym, yes)) {
			if (!first)
				putchar(',');
			json_string("y");
		}
	}
	putchar(']');
}

static void emit_menu(struct menu *menu)
{
	struct menu *child;

	for (child = menu->list; child; child = child->next) {
		struct symbol *sym = child->sym;
		const char *prompt;

		if (!menu_is_visible(child)) {
			emit_menu(child);
			continue;
		}

		prompt = menu_get_prompt(child);
		if (sym && sym->name && prompt && *prompt &&
		    !excluded_symbol(sym->name)) {
			sym_calc_value(sym);
			fputs("{\"name\":", stdout);
			json_string(sym->name);
			fputs(",\"symbol\":", stdout);
			{
				size_t len = strlen(sym->name) + 8;
				char *full = malloc(len);
				if (!full) {
					fprintf(stderr, "out of memory\n");
					exit(2);
				}
				snprintf(full, len, "CONFIG_%s", sym->name);
				json_string(full);
				free(full);
			}
			fputs(",\"prompt\":", stdout);
			json_string(prompt);
			fputs(",\"type\":", stdout);
			json_string(sym_type_name(sym->type));
			fputs(",\"value\":", stdout);
			json_string(sym_get_string_value(sym));
			fputs(",\"assignable\":", stdout);
			print_assignable(sym);
			fputs(",\"visible\":true,\"menuPath\":", stdout);
			print_menu_path(child);
			fputs(",\"help\":", stdout);
			json_string(menu_get_help(child));
			fputs("}\n", stdout);
		}

		emit_menu(child);
	}
}

int main(int argc, char **argv)
{
	const char *config = NULL;

	if (argc < 2 || argc > 3) {
		fprintf(stderr, "usage: %s KCONFIG [CONFIG]\n", argv[0]);
		return 2;
	}
	if (argc == 3)
		config = argv[2];

	conf_parse(argv[1]);
	if (conf_read(config)) {
		fprintf(stderr, "failed to read config\n");
		return 1;
	}
	emit_menu(&rootmenu);
	return 0;
}
