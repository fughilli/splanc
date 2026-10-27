#!/usr/bin/perl
#
# Pin MANUAL App Store signing onto the App target of the Capacitor-generated
# project.pbxproj — and ONLY the App target, for ONE configuration.
#
#   TF_BUNDLE=dev.splanc.app TF_CONFIGURATION=Release TF_TEAM=ABCDE12345 \
#   TF_PROFILE_SPECIFIER=<profile UUID or name> \
#     perl web/ios-config/manual_signing.pl web/ios/App/App.xcodeproj/project.pbxproj
#
# Used by tools/ios_build_server.py's tf-archive when a fixed distribution
# provisioning profile is supplied (APPLE_PROVISIONING_PROFILE_BASE64). Why not
# plain `xcodebuild … CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER=…`?
# Command-line build settings apply to EVERY target in the build, including the
# Swift-package targets (Capacitor, the web/native-plugins/* bridges, their
# resource bundles) — and a package target handed a provisioning profile fails
# with "<target> does not support provisioning profiles". Editing only the
# XCBuildConfiguration blocks that carry the app's PRODUCT_BUNDLE_IDENTIFIER keeps
# the profile on the app and leaves the package targets unsigned (they're
# embedded and re-signed with the app's identity).
#
# Selection: a buildSettings block is patched iff it contains
# `PRODUCT_BUNDLE_IDENTIFIER = $TF_BUNDLE;` and its config is named
# $TF_CONFIGURATION. Within it, every existing CODE_SIGN_STYLE / CODE_SIGN_IDENTITY
# (incl. the `[sdk=iphoneos*]` conditional variant, which would otherwise outrank a
# plain value at the same level) / PROVISIONING_PROFILE[_SPECIFIER] /
# DEVELOPMENT_TEAM line is dropped and replaced by the manual set. Exits non-zero
# if no block matched (a Capacitor template change must fail loudly here, not as a
# confusing xcodebuild signing error later). Prints only setting names + counts.
use strict;
use warnings;

my $path = shift @ARGV or die "usage: manual_signing.pl <project.pbxproj>\n";
my %v;
for my $k (qw(TF_BUNDLE TF_CONFIGURATION TF_TEAM TF_PROFILE_SPECIFIER)) {
    defined $ENV{$k} && length $ENV{$k} or die "manual_signing.pl: $k is not set\n";
    $v{$k} = $ENV{$k};
}
my $identity = $ENV{TF_CODE_SIGN_IDENTITY} // "Apple Distribution";

# pbxproj string quoting: bare if it's a plain token, else a quoted, escaped string.
sub q_ {
    my ($s) = @_;
    return $s if $s =~ /^[A-Za-z0-9_.\/-]+$/;
    $s =~ s/\\/\\\\/g;
    $s =~ s/"/\\"/g;
    return "\"$s\"";
}

open my $in, "<", $path or die "manual_signing.pl: can't read $path: $!\n";
my $src = do { local $/; <$in> };
close $in;

my $patched = 0;
my $drop = qr/^\s*"?(?:CODE_SIGN_STYLE|CODE_SIGN_IDENTITY(?:\[[^\]]*\])?|PROVISIONING_PROFILE|PROVISIONING_PROFILE_SPECIFIER(?:\[[^\]]*\])?|DEVELOPMENT_TEAM(?:\[[^\]]*\])?)"?\s*=[^\n]*\n/m;

$src =~ s{(buildSettings = \{\n)(.*?\n)([ \t]*\};\s*name = "?([^";\n]+)"?;)}{
    my ($head, $body, $tail, $conf) = ($1, $2, $3, $4);
    if ($conf eq $v{TF_CONFIGURATION}
        && $body =~ /^\s*PRODUCT_BUNDLE_IDENTIFIER = "?\Q$v{TF_BUNDLE}\E"?;\s*$/m) {
        my ($ind) = $body =~ /^([ \t]*)\S/;
        $ind //= "\t\t\t\t";
        1 while $body =~ s/$drop//;
        $body = join("",
            "${ind}CODE_SIGN_STYLE = Manual;\n",
            "${ind}CODE_SIGN_IDENTITY = ", q_($identity), ";\n",
            "${ind}\"CODE_SIGN_IDENTITY[sdk=iphoneos*]\" = ", q_($identity), ";\n",
            "${ind}DEVELOPMENT_TEAM = ", q_($v{TF_TEAM}), ";\n",
            "${ind}PROVISIONING_PROFILE_SPECIFIER = ", q_($v{TF_PROFILE_SPECIFIER}), ";\n",
        ) . $body;
        $patched++;
    }
    $head . $body . $tail;
}gse;

if (!$patched) {
    die "manual_signing.pl: no '$v{TF_CONFIGURATION}' build configuration with "
      . "PRODUCT_BUNDLE_IDENTIFIER = $v{TF_BUNDLE} in $path — has the generated "
      . "project's bundle id or layout changed?\n";
}

open my $out, ">", $path or die "manual_signing.pl: can't write $path: $!\n";
print $out $src;
close $out;
print "[manual-signing] pinned CODE_SIGN_STYLE=Manual, CODE_SIGN_IDENTITY, "
    . "DEVELOPMENT_TEAM, PROVISIONING_PROFILE_SPECIFIER on $patched "
    . "'$v{TF_CONFIGURATION}' config(s) of $v{TF_BUNDLE}\n";
