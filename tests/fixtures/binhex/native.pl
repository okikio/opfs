# Authored test harness for the installed Convert::BinHex library; no candidate imports.
use strict;
use warnings;
use Convert::BinHex;
my ($mode, $file, $data, $resource, $name) = @ARGV;
if ($mode eq 'encode') {
    my $h = Convert::BinHex->new(filename => $name, version => 0, type => 'TEST', creator => 'OPFS', flags => 0x8000);
    $h->data(Path => $data);
    $h->resource(Path => $resource);
    open my $out, '>', $file or die $!;
    binmode $out;
    $h->encode($out);
    close $out or die $!;
} elsif ($mode eq 'decode') {
    open my $in, '<', $file or die $!;
    binmode $in;
    # Native macutils uses a different banner. Seek to its genuine colon line
    # and use the documented NoComment capability, without changing wire bytes.
    my $position = 0;
    while (my $line = <$in>) {
        if ($line =~ /^:/) { seek($in, $position, 0) or die $!; last; }
        $position = tell($in);
    }
    my $h = Convert::BinHex->open(FH => $in, NoComment => 1);
    $h->read_header;
    open my $d, '>', $data or die $!;
    binmode $d;
    while (defined(my $bytes = $h->read_data)) { print $d $bytes; }
    close $d or die $!;
    open my $r, '>', $resource or die $!;
    binmode $r;
    while (defined(my $bytes = $h->read_resource)) { print $r $bytes; }
    close $r or die $!;
    print join(':', $h->filename, $h->type, $h->creator, $h->flags), "\n";
} else { die 'unknown authored harness mode'; }
